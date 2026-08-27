// R2 access for source pages (sources/<matterId>.md) and the sync cursor
import { z } from "zod";

import { putJson, readObjects } from "./r2";
import { parseFrontmatter, serializeSource, sourceFrontmatterSchema, type SourceMeta } from "./sources";

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

// every source with its body; reading them all is fine at personal-library scale
export async function listSources(bucket: R2Bucket) {
  const objects = await readObjects({ bucket, prefix: "sources/" });
  return objects.map(({ text }) => parseSource(text));
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
  await putJson({ bucket, key: "sync.json", value: state });
}
