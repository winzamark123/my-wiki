import { Buffer } from "node:buffer";

import type { BookArtwork } from "./artwork";
import {
  bookIndexSchema,
  bookStatusSchema,
  type BookCoverDimensions,
  type BookManifest,
  type BookStatus,
} from "./books";
import { putJson } from "./r2";

export async function getBookIndex(bucket: R2Bucket) {
  const obj = await bucket.get("books/index.json");
  return obj ? bookIndexSchema.parse(await obj.json()) : { exports: [] };
}

export async function getBookStatus({ bucket, bookId }: { bucket: R2Bucket; bookId: string }) {
  const obj = await bucket.get(`books/${bookId}/status.json`);
  if (!obj) throw new Error(`book status not found for ${bookId}`);
  return bookStatusSchema.parse(await obj.json());
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

export function getBookCoverArtworkDataUrl({ bucket, artwork }: { bucket: R2Bucket; artwork: BookArtwork }) {
  return artworkDataUrl({ bucket, key: artwork.cover.key });
}

export async function getBookChapterArtworkDataUrls({
  bucket,
  artwork,
}: {
  bucket: R2Bucket;
  artwork: BookArtwork;
}) {
  const chapters = await Promise.all(
    artwork.chapters.map(({ key, chapter_index, title }) =>
      artworkDataUrl({ bucket, key }).then((src) => ({ chapterIndex: chapter_index, title, src })),
    ),
  );
  return { chapters };
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

export async function writeCoverHtml({ bucket, bookId, html }: { bucket: R2Bucket; bookId: string; html: string }) {
  await bucket.put(`books/${bookId}/cover.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
}

export async function getCoverHtml({ bucket, bookId }: { bucket: R2Bucket; bookId: string }) {
  const obj = await bucket.get(`books/${bookId}/cover.html`);
  if (!obj) throw new Error(`cover HTML not found for ${bookId}`);
  return obj.text();
}

export async function writeCoverPdf({
  bucket,
  bookId,
  html,
  pdf,
  interiorStatus,
  dimensions,
  now,
}: {
  bucket: R2Bucket;
  bookId: string;
  html: string;
  pdf: Uint8Array;
  interiorStatus: Extract<BookStatus, { state: "interior_ready" }>;
  dimensions: BookCoverDimensions;
  now: string;
}) {
  const status: BookStatus = {
    ...interiorStatus,
    state: "cover_ready",
    cover_dimensions: dimensions,
    updated_at: now,
  };
  await Promise.all([
    writeCoverHtml({ bucket, bookId, html }),
    bucket.put(`books/${bookId}/cover.pdf`, pdf, { httpMetadata: { contentType: "application/pdf" } }),
    putJson({ bucket, key: `books/${bookId}/status.json`, value: status }),
  ]);
}

export async function writeCoverFailure({
  bucket,
  bookId,
  interiorStatus,
  dimensions,
  error,
  now,
}: {
  bucket: R2Bucket;
  bookId: string;
  interiorStatus: Extract<BookStatus, { state: "interior_ready" }>;
  dimensions?: BookCoverDimensions;
  error: string;
  now: string;
}) {
  const status: BookStatus = {
    ...interiorStatus,
    state: "cover_failed",
    cover_dimensions: dimensions,
    error,
    updated_at: now,
  };
  await putJson({ bucket, key: `books/${bookId}/status.json`, value: status });
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
