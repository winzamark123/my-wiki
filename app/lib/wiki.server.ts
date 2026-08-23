// content store access. R2 layout and the write seam — see ARCHITECTURE.md

import { nearestPages, pageKey, refreshEmbeddings } from "./embeddings.server";
import { readObjects } from "./r2.server";
import { listSourceMeta } from "./sources.server";
import {
  parseFrontmatter,
  resolveSlug,
  slugify,
  SOURCE_CITE_PREFIX,
  wikiIndexSchema,
  WIKI_LINK_RE_G,
  type WikiIndex,
} from "./wiki";

export const CACHE_HEADERS = { "Cache-Control": "public, max-age=0, s-maxage=60" };

function extractWikiLinks(body: string) {
  const links = new Set<string>();
  const cites = new Set<string>();
  for (const m of body.matchAll(WIKI_LINK_RE_G)) {
    const target = m[1].trim();
    if (target.startsWith(SOURCE_CITE_PREFIX)) cites.add(target.slice(SOURCE_CITE_PREFIX.length).trim());
    else links.add(slugify(target));
  }
  return { links: [...links], cites: [...cites] };
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
  if (!obj) return { pages: [], sources: [], aliases: {} };
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

// rebuilt from scratch on every write; O(pages + sources) reads is fine at personal-wiki scale
export async function regenerateIndex(bucket: R2Bucket, ai: Ai) {
  const [pages, sources] = await Promise.all([
    readObjects({ bucket, prefix: "wiki/" }),
    listSourceMeta(bucket),
  ]);

  const index: WikiIndex = {
    pages: [],
    sources: sources.map((meta) => ({ ...meta, near: [] })),
    aliases: {},
  };
  const rawLinks: Record<string, string[]> = {};
  for (const { key, text } of pages) {
    const slug = key.slice("wiki/".length).replace(/\.md$/, "");
    const { attrs, body } = parseFrontmatter(text);
    const { links, cites } = extractWikiLinks(body);
    rawLinks[slug] = links;
    index.pages.push({ slug, title: attrs.title ?? slug, summary: summarize(body), links: [], cites });
    for (const alias of (attrs.aliases ?? "").split(",")) {
      if (alias.trim()) index.aliases[slugify(alias)] = slug;
    }
  }
  // resolve after all aliases are known, so index edges match rendered links
  for (const page of index.pages) {
    page.links = [...new Set(rawLinks[page.slug].map((l) => resolveSlug(l, index.aliases)))];
  }

  // similarity edges attach unread sources to topic pages; archived ones get citation edges instead
  const texts: Record<string, string> = {};
  for (const page of index.pages) texts[pageKey(page.slug)] = `${page.title}\n${page.summary}`;
  for (const source of index.sources) texts[source.matter_id] = `${source.title}\n${source.excerpt ?? ""}`;
  // an embedding outage (or local dev without Workers AI access) must not block writes; edges just go stale
  const store = await refreshEmbeddings({ bucket, ai, texts }).catch((error: unknown) => {
    console.error("embeddings skipped:", error instanceof Error ? error.message : error);
    return null;
  });
  if (store) {
    const pageSlugs = index.pages.map((page) => page.slug);
    for (const source of index.sources) {
      if (source.state !== "archived") source.near = nearestPages({ store, sourceId: source.matter_id, pageSlugs });
    }
  }

  index.pages.sort((a, b) => a.title.localeCompare(b.title));
  index.sources.sort((a, b) => a.title.localeCompare(b.title));
  await bucket.put("index.json", JSON.stringify(index), {
    httpMetadata: { contentType: "application/json" },
  });
  return index;
}

// the write seam: every content write goes through here (history copy now; git mirror later)
export async function writePage({
  bucket,
  ai,
  slug,
  content,
}: {
  bucket: R2Bucket;
  ai: Ai;
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
  await regenerateIndex(bucket, ai);
  // TODO: purge edge cache for /wiki/<slug> and / once deployed; until then s-maxage=60 bounds staleness
}

export async function appendLog(bucket: R2Bucket, entry: string) {
  const existing = await bucket.get("log.md");
  const log = existing ? await existing.text() : "# Log\n";
  await bucket.put("log.md", `${log}\n- ${new Date().toISOString()} — ${entry}`, {
    httpMetadata: { contentType: "text/markdown" },
  });
}
