// content store access. R2 layout and the write seam — see ARCHITECTURE.md

import {
  parseFrontmatter,
  resolveSlug,
  slugify,
  wikiIndexSchema,
  WIKI_LINK_RE_G,
  type WikiIndex,
} from "./wiki";

export const CACHE_HEADERS = { "Cache-Control": "public, max-age=0, s-maxage=60" };

function extractWikiLinks(body: string) {
  const links = new Set<string>();
  for (const m of body.matchAll(WIKI_LINK_RE_G)) {
    links.add(slugify(m[1]));
  }
  return [...links];
}

// raw page markdown including frontmatter; null when missing
export async function getPageRaw(bucket: R2Bucket, slug: string) {
  const obj = await bucket.get(`wiki/${slug}.md`);
  return obj ? obj.text() : null;
}

export async function getPage(bucket: R2Bucket, slug: string) {
  const raw = await getPageRaw(bucket, slug);
  if (raw === null) return null;
  const { attrs, body } = parseFrontmatter(raw);
  return { slug, title: attrs.title ?? slug, body };
}

export async function getIndex(bucket: R2Bucket) {
  const obj = await bucket.get("index.json");
  if (!obj) return { pages: [], aliases: {} };
  return wikiIndexSchema.parse(await obj.json());
}

function summarize(body: string) {
  const para = body
    .split("\n\n")
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#"));
  const text = (para ?? "").replace(WIKI_LINK_RE_G, (_, target, label) => label ?? target);
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
    page.links = [...new Set(rawLinks[page.slug].map((l) => resolveSlug(l, index.aliases)))];
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
