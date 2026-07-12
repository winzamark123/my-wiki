import { z } from "zod";

const indexEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  links: z.array(z.string()),
});

export const wikiIndexSchema = z.object({
  pages: z.array(indexEntrySchema),
  aliases: z.record(z.string(), z.string()),
});

export type WikiIndex = z.infer<typeof wikiIndexSchema>;

// the index projection LLM prompts see (drops link edges)
export function indexForPrompt(index: WikiIndex) {
  return index.pages.map(({ slug, title, summary }) => ({ slug, title, summary }));
}

export function existingSlugs(index: WikiIndex) {
  return new Set(index.pages.map((page) => page.slug));
}

// defines "is a red link": some existing page must link to the missing slug
export function referringPages(index: WikiIndex, slug: string) {
  return index.pages.filter((page) => page.links.includes(slug));
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

function escapeMarkdownLabel(label: string) {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function prepareStreamingMarkdown({
  body,
  index,
}: {
  body: string;
  index: WikiIndex;
}) {
  const completeLinks = body.replace(
    WIKI_LINK_RE_G,
    (_, target: string, label: string | undefined) => {
      const slug = resolveSlug(target, index.aliases);
      return `[${escapeMarkdownLabel(label ?? target)}](/wiki/${slug})`;
    },
  );

  // hide a trailing half-written wiki link until the model closes it
  return completeLinks.replace(
    /\[\[([^\]\n|]*)(?:\|([^\]\n]*))?$/,
    (_, target: string, label: string | undefined) => label ?? target,
  );
}
