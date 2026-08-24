// one vector per source for link candidates. see ARCHITECTURE.md → Links
import { z } from "zod";

// 8192-token context, so a whole article fits in one vector; changing the model re-embeds everything
const MODEL = "@cf/baai/bge-m3";
const DIMS = 1024;
// long inputs: keep requests small
const BATCH_SIZE = 10;

const storeSchema = z.object({
  model: z.string(),
  dims: z.number(),
  // keyed by matter id; the hash of the embedded text detects when a vector is stale
  vectors: z.record(z.string(), z.object({ hash: z.string(), vector: z.array(z.number()) })),
});

export type EmbeddingStore = z.infer<typeof storeSchema>;

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// a store from another model or an older layout starts over; everything re-embeds on the next refresh
export async function getEmbeddingStore(bucket: R2Bucket): Promise<EmbeddingStore> {
  const obj = await bucket.get("embeddings.json");
  const stored = obj ? storeSchema.safeParse(await obj.json()) : null;
  return stored?.success && stored.data.model === MODEL ? stored.data : { model: MODEL, dims: DIMS, vectors: {} };
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
  const store = await getEmbeddingStore(bucket);
  const hashes = Object.fromEntries(
    await Promise.all(Object.entries(texts).map(async ([key, text]) => [key, await sha256(text)] as const)),
  );
  const stale = Object.keys(texts).filter((key) => store.vectors[key]?.hash !== hashes[key]);
  const orphans = Object.keys(store.vectors).filter((key) => !(key in texts));
  if (stale.length === 0 && orphans.length === 0) return store;

  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = stale.slice(i, i + BATCH_SIZE);
    const result = await ai.run(MODEL, { text: batch.map((key) => texts[key]), truncate_inputs: true });
    const vectors = "data" in result ? (result.data ?? []) : [];
    if (vectors.length !== batch.length) {
      throw new Error(`embedding count mismatch: sent ${batch.length}, got ${vectors.length}`);
    }
    batch.forEach((key, j) => {
      store.vectors[key] = { hash: hashes[key], vector: vectors[j] };
    });
  }

  // drop vectors for sources that no longer exist
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

// the closest other sources, best first; brute force is fine at personal scale
export function nearestSources({ store, sourceId, count }: { store: EmbeddingStore; sourceId: string; count: number }) {
  const source = store.vectors[sourceId];
  if (!source) return [];
  return Object.entries(store.vectors)
    .filter(([id]) => id !== sourceId)
    .map(([id, { vector }]) => ({ id, score: cosine(source.vector, vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ id }) => id);
}
