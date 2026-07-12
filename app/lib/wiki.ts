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

// single definition of the [[target|label]] grammar; anchor or add flags per call site
export const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/;

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
    new RegExp(WIKI_LINK_RE.source, "g"),
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
