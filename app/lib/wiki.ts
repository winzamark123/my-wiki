import { z } from "zod";

import { sourceMetaSchema } from "./sources";

const indexEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  links: z.array(z.string()),
  // matter ids this page cites via [[source:…]]
  cites: z.array(z.string()),
});

const indexSourceSchema = sourceMetaSchema.extend({
  // nearest topic pages by embedding; empty once archived (citations take over)
  near: z.array(z.string()),
});

export const wikiIndexSchema = z.object({
  pages: z.array(indexEntrySchema),
  sources: z.array(indexSourceSchema),
  aliases: z.record(z.string(), z.string()),
});

export type WikiIndex = z.infer<typeof wikiIndexSchema>;
export type IndexSource = z.infer<typeof indexSourceSchema>;

// the index projection LLM prompts see (drops graph edges and source bodies)
export function indexForPrompt(index: WikiIndex) {
  return {
    pages: index.pages.map(({ slug, title, summary }) => ({ slug, title, summary })),
    sources: index.sources.map(({ matter_id, title, site, state }) => ({ id: matter_id, title, site, state })),
  };
}

// a wiki link whose target is `source:<matterId>` is a citation, not a page link
export const SOURCE_CITE_PREFIX = "source:";

export function existingSlugs(index: WikiIndex) {
  return new Set(index.pages.map((page) => page.slug));
}

// single definition of the [[target|label]] grammar; anchor per call site (see markdown.server)
export const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/;
// shared global variant — safe because matchAll clones and replace resets lastIndex
export const WIKI_LINK_RE_G = new RegExp(WIKI_LINK_RE.source, "g");

export function slugify(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// the one place link targets resolve to canonical slugs (alias dedup)
export function resolveSlug(target: string, aliases: Record<string, string>) {
  const slug = slugify(target);
  return aliases[slug] ?? slug;
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
