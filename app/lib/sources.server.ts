// R2 access for source pages (sources/<matterId>.md) and the sync cursor
import { z } from "zod";

import { readObjects } from "./r2.server";
import { embeddingText, parseFrontmatter, serializeSource, sourceFrontmatterSchema, type SourceMeta } from "./sources";

// frontmatter fits comfortably in this many bytes (title, url, 500-char excerpt, timestamps)
const FRONTMATTER_BYTES = 4096;
const FRONTMATTER_END = "\n---\n";

function parseSource(raw: string) {
  const { attrs, body } = parseFrontmatter(raw);
  return { meta: sourceFrontmatterSchema.parse(attrs), body };
}

const syncStateSchema = z.object({
  cursor: z.string().optional(),
  lastRun: z.string().optional(),
});

export async function getSource(bucket: R2Bucket, id: string) {
  const obj = await bucket.get(`sources/${id}.md`);
  return obj ? parseSource(await obj.text()) : null;
}

// embedding input for every source; reads every body, fine at personal-library scale
export async function listEmbeddingTexts(bucket: R2Bucket) {
  const objects = await readObjects({ bucket, prefix: "sources/" });
  const texts: Record<string, string> = {};
  for (const { text } of objects) {
    const { meta, body } = parseSource(text);
    texts[meta.matter_id] = embeddingText({ title: meta.title, body });
  }
  return texts;
}

// metadata for every source, reading only each object's head; bodies stay in R2
export async function listSourceMeta(bucket: R2Bucket) {
  const heads = await readObjects({ bucket, prefix: "sources/", headBytes: FRONTMATTER_BYTES });
  return Promise.all(
    heads.map(async ({ key, text }) => {
      // a rare oversized frontmatter falls back to the full object
      const raw = text.includes(FRONTMATTER_END) ? text : await bucket.get(key).then((o) => o?.text());
      return parseSource(raw ?? "").meta;
    }),
  );
}

// the index is regenerated once per sync, not per write
export async function writeSource({
  bucket,
  meta,
  body,
}: {
  bucket: R2Bucket;
  meta: SourceMeta;
  body: string;
}) {
  await bucket.put(`sources/${meta.matter_id}.md`, serializeSource({ meta, body }), {
    httpMetadata: { contentType: "text/markdown" },
  });
}

export async function getSyncState(bucket: R2Bucket) {
  const obj = await bucket.get("sync.json");
  return obj ? syncStateSchema.parse(await obj.json()) : {};
}

export async function writeSyncState(bucket: R2Bucket, state: z.infer<typeof syncStateSchema>) {
  await bucket.put("sync.json", JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
}
