// source pages: one per Matter item. shared pure helpers; storage lives in sources.server
import { z } from "zod";

import type { MatterItem } from "./matter.server";

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
  synthesized_at: z.string().optional(),
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

// frontmatter from a Matter item, carrying over fields that only the wiki knows (archived_at, synthesized_at)
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
    synthesized_at: previous?.synthesized_at,
    matter_updated_at: item.updated_at,
  };
}

export function serializeSource({ meta, body }: { meta: SourceMeta; body: string }) {
  const lines = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}
