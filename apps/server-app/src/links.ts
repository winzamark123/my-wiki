// labeled links between sources: embedding candidates → reranker → LLM verdict and label.
// see ARCHITECTURE.md → Links
import { z } from "zod";

import { parseModelJson, TEXT_MODEL } from "./ai";
import { getEmbeddingStore, nearestSources, type EmbeddingStore } from "./embeddings";
import { putJson } from "./r2";
import { headText } from "./sources";
import { getSource } from "./source-store";
import type { Link } from "./wiki";

const RERANKER = "@cf/baai/bge-reranker-base";
// candidates from embeddings, how many the reranker forwards, and its 0–1 score floor
const CANDIDATES = 8;
const RERANK_KEEP = 4;
const RERANK_FLOOR = 0.2;

const linksSchema = z.object({
  // keyed by pairKey; label null means the pair was judged and rejected, so it is not asked again
  pairs: z.record(z.string(), z.object({ label: z.string().nullable() })),
  // hash of the embedded text each source was last linked with
  evaluated: z.record(z.string(), z.string()),
});

type LinkStore = z.infer<typeof linksSchema>;

const verdictSchema = z.object({
  links: z.array(z.object({ index: z.number(), related: z.boolean(), label: z.string() })),
});

const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          related: { type: "boolean" },
          label: { type: "string" },
        },
        required: ["index", "related", "label"],
      },
    },
  },
  required: ["links"],
};

const SYSTEM_PROMPT = `You compare articles from one person's reading list. For each candidate, decide whether it is genuinely related to the article (same subject, same question, one builds on the other, or they disagree about the same thing). Sharing a broad field is not enough.
For related candidates write a label of at most 8 words, lowercase, naming what they share, e.g. "both on choosing research problems". For unrelated candidates set related to false and label to "".`;

export function pairKey(a: string, b: string) {
  return [a, b].sort().join("|");
}

export async function getLinks(bucket: R2Bucket): Promise<LinkStore> {
  const obj = await bucket.get("links.json");
  return obj ? linksSchema.parse(await obj.json()) : { pairs: {}, evaluated: {} };
}

// sources whose vector changed since they were last linked
export function pendingSources({ store, links }: { store: EmbeddingStore; links: LinkStore }) {
  return Object.entries(store.vectors)
    .filter(([id, { hash }]) => links.evaluated[id] !== hash)
    .map(([id]) => id);
}

// accepted pairs between sources that still exist
export function relatedLinks({ links, ids }: { links: LinkStore; ids: Set<string> }): Link[] {
  return Object.entries(links.pairs).flatMap(([key, { label }]) => {
    const [a, b] = key.split("|");
    return label && ids.has(a) && ids.has(b) ? [{ a, b, label }] : [];
  });
}

async function head(bucket: R2Bucket, id: string) {
  const source = await getSource(bucket, id);
  return source ? headText({ title: source.meta.title, body: source.body }) : null;
}

async function linkSource({
  bucket,
  ai,
  store,
  links,
  sourceId,
}: {
  bucket: R2Bucket;
  ai: Ai;
  store: EmbeddingStore;
  links: LinkStore;
  sourceId: string;
}) {
  // the text changed, so every earlier verdict about this source is void
  for (const key of Object.keys(links.pairs)) {
    if (key.split("|").includes(sourceId)) delete links.pairs[key];
  }
  const candidates = nearestSources({ store, sourceId, count: CANDIDATES }).filter(
    (id) => !(pairKey(sourceId, id) in links.pairs),
  );
  const text = await head(bucket, sourceId);
  const heads = await Promise.all(candidates.map((id) => head(bucket, id)));
  const pool = candidates.flatMap((id, i) => (heads[i] ? [{ id, text: heads[i] }] : []));

  let kept: typeof pool = [];
  if (text && pool.length > 0) {
    // the generated input type omits `query`; a typed variable sidesteps the literal check
    const input: { query: string; contexts: { text: string }[]; top_k: number } = {
      query: text,
      contexts: pool.map(({ text }) => ({ text })),
      top_k: RERANK_KEEP,
    };
    const ranked = await ai.run(RERANKER, input);
    kept = (ranked.response ?? [])
      .filter((r) => r.id !== undefined && (r.score ?? 0) >= RERANK_FLOOR)
      .map((r) => pool[r.id ?? 0]);
  }
  for (const { id } of pool) links.pairs[pairKey(sourceId, id)] = { label: null };

  if (text && kept.length > 0) {
    const result = await ai.run(TEXT_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `ARTICLE:\n${text}`,
            ...kept.map(({ text }, i) => `CANDIDATE ${i}:\n${text}`),
            `Return JSON: { "links": [{ "index": <candidate number>, "related": <bool>, "label": <string> }] } with one entry per candidate.`,
          ].join("\n\n---\n\n"),
        },
      ],
      response_format: { type: "json_schema", json_schema: VERDICT_JSON_SCHEMA },
      max_tokens: 400,
      temperature: 0.2,
    });
    const verdict = parseModelJson({ result, schema: verdictSchema });
    for (const { index, related, label } of verdict.links) {
      const candidate = kept[index];
      if (candidate && related && label.trim()) {
        links.pairs[pairKey(sourceId, candidate.id)] = { label: label.trim().toLowerCase() };
      }
    }
  }

  links.evaluated[sourceId] = store.vectors[sourceId].hash;
}

// links a batch of sources and persists links.json once
export async function linkSources({ bucket, ai, ids }: { bucket: R2Bucket; ai: Ai; ids: string[] }) {
  const [store, links] = await Promise.all([getEmbeddingStore(bucket), getLinks(bucket)]);
  for (const sourceId of ids) {
    if (store.vectors[sourceId]) await linkSource({ bucket, ai, store, links, sourceId });
  }
  await putJson({ bucket, key: "links.json", value: links });
  return links;
}
