import { Buffer } from "node:buffer";

import type { BookArtwork } from "./artwork";
import { bookIndexSchema, type BookManifest, type BookStatus } from "./books";
import { putJson } from "./r2";

export async function getBookIndex(bucket: R2Bucket) {
  const obj = await bucket.get("books/index.json");
  return obj ? bookIndexSchema.parse(await obj.json()) : { exports: [] };
}

export async function writeBookManifest({ bucket, manifest }: { bucket: R2Bucket; manifest: BookManifest }) {
  await putJson({ bucket, key: `books/${manifest.id}/manifest.json`, value: manifest });
}

export async function writeBookArtwork({ bucket, bookId, artwork }: { bucket: R2Bucket; bookId: string; artwork: BookArtwork }) {
  await putJson({ bucket, key: `books/${bookId}/artwork.json`, value: artwork });
}

const artworkExtensions: Record<BookArtwork["cover"]["content_type"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

export async function writeArtworkImage({
  bucket,
  bookId,
  name,
  bytes,
  contentType,
}: {
  bucket: R2Bucket;
  bookId: string;
  name: string;
  bytes: Uint8Array;
  contentType: BookArtwork["cover"]["content_type"];
}) {
  const key = `books/${bookId}/artwork/${name}.${artworkExtensions[contentType]}`;
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
  return key;
}

async function artworkDataUrl({ bucket, key }: { bucket: R2Bucket; key: string }) {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`artwork image not found: ${key}`);
  const contentType = obj.httpMetadata?.contentType;
  if (!contentType?.startsWith("image/")) throw new Error(`artwork image has invalid content type: ${key}`);
  return `data:${contentType};base64,${Buffer.from(await obj.arrayBuffer()).toString("base64")}`;
}

export async function getBookArtworkDataUrls({
  bucket,
  artwork,
}: {
  bucket: R2Bucket;
  artwork: BookArtwork;
}) {
  const [cover, ...chapters] = await Promise.all([
    artworkDataUrl({ bucket, key: artwork.cover.key }),
    ...artwork.chapters.map(({ key, chapter_index, title }) =>
      artworkDataUrl({ bucket, key }).then((src) => ({ chapterIndex: chapter_index, title, src })),
    ),
  ]);
  return { cover, chapters };
}

export async function writeInteriorHtml({ bucket, bookId, html }: { bucket: R2Bucket; bookId: string; html: string }) {
  await bucket.put(`books/${bookId}/interior.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
}

export async function getInteriorHtml({ bucket, bookId }: { bucket: R2Bucket; bookId: string }) {
  const obj = await bucket.get(`books/${bookId}/interior.html`);
  if (!obj) throw new Error(`interior HTML not found for ${bookId}`);
  return obj.text();
}

export async function writeInteriorPdf({
  bucket,
  bookId,
  pdf,
  pageCount,
  unavailableImages,
  now,
}: {
  bucket: R2Bucket;
  bookId: string;
  pdf: Uint8Array;
  pageCount: number;
  unavailableImages: string[];
  now: string;
}) {
  const status: BookStatus = {
    state: "interior_ready",
    page_count: pageCount,
    unavailable_images: unavailableImages,
    updated_at: now,
  };
  await Promise.all([
    bucket.put(`books/${bookId}/interior.pdf`, pdf, { httpMetadata: { contentType: "application/pdf" } }),
    putJson({ bucket, key: `books/${bookId}/status.json`, value: status }),
  ]);
}
