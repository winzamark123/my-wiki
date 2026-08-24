// source pages: one per Matter item. shared pure helpers; storage lives in source-store
import { z } from "zod";

import type { MatterItem } from "./matter";

export const sourceStates = ["queued", "reading", "archived"] as const;

export const sourceMetaSchema = z.object({
  matter_id: z.string(),
  title: z.string(),
  url: z.string(),
  site: z.string().optional(),
  author: z.string().optional(),
  content_type: z.string(),
  word_count: z.number().optional(),
  state: z.enum(sourceStates),
  progress: z.number(),
  favorite: z.boolean(),
  excerpt: z.string().optional(),
  archived_at: z.string().optional(),
  matter_updated_at: z.string(),
});

// frontmatter is parsed from `key: value` lines, so every field arrives as a string
export const sourceFrontmatterSchema = sourceMetaSchema.extend({
  word_count: z.coerce.number().optional(),
  progress: z.coerce.number(),
  favorite: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export type SourceMeta = z.infer<typeof sourceMetaSchema>;

// archive means finished regardless of progress; many items are archived without scrolling to the end
export function deriveState(item: Pick<MatterItem, "status" | "reading_progress">) {
  if (item.status === "archive") return "archived" as const;
  return item.reading_progress > 0 ? ("reading" as const) : ("queued" as const);
}

function singleLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

// frontmatter from a Matter item, carrying over the field only the wiki knows (archived_at)
export function sourceMetaFromItem({
  item,
  previous,
  now,
}: {
  item: MatterItem;
  previous?: SourceMeta;
  now: string;
}): SourceMeta {
  const state = deriveState(item);
  return {
    matter_id: item.id,
    title: singleLine(item.title) || item.url,
    url: item.url,
    site: item.site_name ? singleLine(item.site_name) : undefined,
    author: item.author?.name ? singleLine(item.author.name) : undefined,
    content_type: item.content_type,
    word_count: item.word_count ?? undefined,
    state,
    progress: item.reading_progress,
    favorite: item.is_favorite,
    excerpt: item.excerpt ? singleLine(item.excerpt).slice(0, 500) : undefined,
    archived_at: previous?.archived_at ?? (state === "archived" ? now : undefined),
    matter_updated_at: item.updated_at,
  };
}

export function serializeSource({ meta, body }: { meta: SourceMeta; body: string }) {
  const lines = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export function parseFrontmatter(raw: string) {
  const attrs: Record<string, string> = {};
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { attrs, body: raw };
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep > 0) attrs[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { attrs, body: raw.slice(match[0].length) };
}

// what the models read: title plus the article text without images, link targets, or Matter's escapes
export function cleanBody(body: string) {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// bge-m3 truncates at 8192 tokens (~30k chars); the cap only bounds the request payload
const EMBED_CHARS = 40_000;
// what the reranker and the labeler see per article (both read ~512 tokens)
const HEAD_CHARS = 1_500;

export function embeddingText({ title, body }: { title: string; body: string }) {
  return `${title}\n\n${cleanBody(body)}`.slice(0, EMBED_CHARS);
}

export function headText({ title, body }: { title: string; body: string }) {
  return `${title}\n\n${cleanBody(body)}`.slice(0, HEAD_CHARS);
}
