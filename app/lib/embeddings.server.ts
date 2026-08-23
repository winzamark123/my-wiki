// embeddings for similarity edges. see ARCHITECTURE.md → Schema → embeddings.json
import { z } from "zod";

// cls pooling per Cloudflare's recommendation; vectors from different pooling modes don't mix
const MODEL = "@cf/baai/bge-base-en-v1.5";
const DIMS = 768;
// bge-base cls cosine on this library: unrelated text 0.37–0.55, related 0.65+
const NEAR_THRESHOLD = 0.65;
const NEAR_COUNT = 2;
// Workers AI accepts up to 100 texts per call
const BATCH_SIZE = 100;

const storeSchema = z.object({
  model: z.string(),
  dims: z.number(),
  // keyed by matter id or "wiki:<slug>"; text is kept to detect when a vector is stale
  vectors: z.record(z.string(), z.object({ text: z.string(), vector: z.array(z.number()) })),
});

type EmbeddingStore = z.infer<typeof storeSchema>;

export function pageKey(slug: string) {
  return `wiki:${slug}`;
}

async function getStore(bucket: R2Bucket): Promise<EmbeddingStore> {
  const obj = await bucket.get("embeddings.json");
  const stored = obj ? storeSchema.parse(await obj.json()) : null;
  return stored?.model === MODEL ? stored : { model: MODEL, dims: DIMS, vectors: {} };
}

// embeds whatever is missing or changed, persists the store, and returns it
export async function refreshEmbeddings({
  bucket,
  ai,
  texts,
}: {
  bucket: R2Bucket;
  ai: Ai;
  texts: Record<string, string>;
}) {
  const store = await getStore(bucket);
  const stale = Object.entries(texts).filter(([key, text]) => store.vectors[key]?.text !== text);
  const orphans = Object.keys(store.vectors).filter((key) => !(key in texts));
  if (stale.length === 0 && orphans.length === 0) return store;

  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = stale.slice(i, i + BATCH_SIZE);
    const result = await ai.run(MODEL, { text: batch.map(([, text]) => text), pooling: "cls" });
    const vectors = "data" in result ? (result.data ?? []) : [];
    if (vectors.length !== batch.length) {
      throw new Error(`embedding count mismatch: sent ${batch.length}, got ${vectors.length}`);
    }
    batch.forEach(([key, text], j) => {
      store.vectors[key] = { text, vector: vectors[j] };
    });
  }

  // drop vectors for things that no longer exist
  for (const key of orphans) delete store.vectors[key];
  await bucket.put("embeddings.json", JSON.stringify(store), {
    httpMetadata: { contentType: "application/json" },
  });
  return store;
}

function cosine(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// nearest topic pages for one source; brute force is fine at personal scale
export function nearestPages({
  store,
  sourceId,
  pageSlugs,
}: {
  store: EmbeddingStore;
  sourceId: string;
  pageSlugs: string[];
}) {
  const source = store.vectors[sourceId];
  if (!source) return [];
  return pageSlugs
    .flatMap((slug) => {
      const page = store.vectors[pageKey(slug)];
      return page ? [{ slug, score: cosine(source.vector, page.vector) }] : [];
    })
    .filter(({ score }) => score >= NEAR_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, NEAR_COUNT)
    .map(({ slug }) => slug);
}
