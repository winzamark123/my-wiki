// content store access. R2 layout and the write seam — see ARCHITECTURE.md

export interface IndexEntry {
  slug: string;
  title: string;
  summary: string;
  links: string[];
}

export interface WikiIndex {
  pages: IndexEntry[];
  aliases: Record<string, string>;
}

// single definition of the [[target|label]] grammar; anchor or add flags per call site
export const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/;

export const CACHE_HEADERS = { "Cache-Control": "public, max-age=0, s-maxage=60" };

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
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { attrs: {} as Record<string, string>, body: raw };
  const attrs: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep > 0) attrs[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { attrs, body: raw.slice(match[0].length) };
}

function extractWikiLinks(body: string) {
  const links = new Set<string>();
  for (const m of body.matchAll(new RegExp(WIKI_LINK_RE.source, "g"))) {
    links.add(slugify(m[1]));
  }
  return [...links];
}

export async function getPage(bucket: R2Bucket, slug: string) {
  const obj = await bucket.get(`wiki/${slug}.md`);
  if (!obj) return null;
  const { attrs, body } = parseFrontmatter(await obj.text());
  return { slug, title: attrs.title ?? slug, body };
}

export async function getIndex(bucket: R2Bucket) {
  const obj = await bucket.get("index.json");
  if (!obj) return { pages: [], aliases: {} } as WikiIndex;
  return (await obj.json()) as WikiIndex;
}

function summarize(body: string) {
  const para = body
    .split("\n\n")
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#"));
  const text = (para ?? "").replace(
    new RegExp(WIKI_LINK_RE.source, "g"),
    (_, target, label) => label ?? target,
  );
  return text.length > 200 ? text.slice(0, 197) + "…" : text;
}

// rebuilt from scratch on every write; O(pages) reads is fine at personal-wiki scale
export async function regenerateIndex(bucket: R2Bucket) {
  const listed = await bucket.list({ prefix: "wiki/" });
  const raws = await Promise.all(
    listed.objects.map(async (obj) => ({
      slug: obj.key.slice("wiki/".length).replace(/\.md$/, ""),
      raw: await bucket.get(obj.key).then((r) => r?.text()),
    })),
  );

  const index: WikiIndex = { pages: [], aliases: {} };
  const rawLinks: Record<string, string[]> = {};
  for (const { slug, raw } of raws) {
    if (raw === undefined) continue;
    const { attrs, body } = parseFrontmatter(raw);
    rawLinks[slug] = extractWikiLinks(body);
    index.pages.push({ slug, title: attrs.title ?? slug, summary: summarize(body), links: [] });
    for (const alias of (attrs.aliases ?? "").split(",")) {
      if (alias.trim()) index.aliases[slugify(alias)] = slug;
    }
  }
  // resolve after all aliases are known, so index edges match rendered links
  for (const page of index.pages) {
    page.links = [...new Set(rawLinks[page.slug].map((l) => index.aliases[l] ?? l))];
  }

  index.pages.sort((a, b) => a.title.localeCompare(b.title));
  await bucket.put("index.json", JSON.stringify(index), {
    httpMetadata: { contentType: "application/json" },
  });
  return index;
}

// the write seam: every content write goes through here (history copy now; git mirror later)
export async function writePage({
  bucket,
  slug,
  content,
}: {
  bucket: R2Bucket;
  slug: string;
  content: string;
}) {
  const previous = await bucket.get(`wiki/${slug}.md`);
  if (previous) {
    await bucket.put(`history/${slug}/${new Date().toISOString()}.md`, await previous.text());
  }
  await bucket.put(`wiki/${slug}.md`, content, {
    httpMetadata: { contentType: "text/markdown" },
  });
  await regenerateIndex(bucket);
  // TODO: purge edge cache for /wiki/<slug> and / once deployed; until then s-maxage=60 bounds staleness
}

export async function appendLog(bucket: R2Bucket, entry: string) {
  const existing = await bucket.get("log.md");
  const log = existing ? await existing.text() : "# Log\n";
  await bucket.put("log.md", `${log}\n- ${new Date().toISOString()} — ${entry}`, {
    httpMetadata: { contentType: "text/markdown" },
  });
}
