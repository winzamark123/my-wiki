// content store access. R2 layout — see ARCHITECTURE.md

import { refreshEmbeddings } from "./embeddings";
import { getLinks, pendingSources, relatedLinks } from "./links";
import { putJson } from "./r2";
import { listSources } from "./source-store";
import { embeddingText } from "./sources";
import { wikiIndexSchema } from "./wiki";

export async function getIndex(bucket: R2Bucket) {
  const obj = await bucket.get("index.json");
  if (!obj) return { sources: [], links: [] };
  return wikiIndexSchema.parse(await obj.json());
}

// rebuilt from scratch after every sync. returns the sources still to be linked
export async function regenerateIndex(bucket: R2Bucket, ai: Ai) {
  const [parsed, links] = await Promise.all([listSources(bucket), getLinks(bucket)]);
  const sources = parsed.map(({ meta }) => meta);
  const texts = Object.fromEntries(
    parsed.map(({ meta, body }) => [meta.matter_id, embeddingText({ title: meta.title, body })]),
  );
  // an embedding outage (or local dev without Workers AI access) must not block the sync; links just go stale
  const store = await refreshEmbeddings({ bucket, ai, texts }).catch((error: unknown) => {
    console.error("embeddings skipped:", error instanceof Error ? error.message : error);
    return null;
  });

  sources.sort((a, b) => a.title.localeCompare(b.title));
  const ids = new Set(sources.map((s) => s.matter_id));
  const related = relatedLinks({ links, ids });
  await putJson({ bucket, key: "index.json", value: { sources, links: related } });
  return { sources: sources.length, links: related.length, pending: store ? pendingSources({ store, links }) : [] };
}

export async function appendLog(bucket: R2Bucket, entry: string) {
  const existing = await bucket.get("log.md");
  const log = existing ? await existing.text() : "# Log\n";
  await bucket.put("log.md", `${log}\n- ${new Date().toISOString()} — ${entry}`, {
    httpMetadata: { contentType: "text/markdown" },
  });
}
