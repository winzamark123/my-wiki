# Architecture

How [DESIGN.md](DESIGN.md) maps onto Cloudflare. DESIGN.md says *what*; this says *with which primitives and why*. Decisions here were made against docs current as of August 2026.

## Stack at a glance

- **App**: React Router v8 (framework mode) + shadcn/ui + Tailwind, deployed to Workers via `@cloudflare/vite-plugin`
- **Content store**: R2 (markdown, index, embeddings, book files)
- **Jobs**: Cloudflare Workflows (Matter sync, synthesis, book build; later lint and digest)
- **LLM**: GPT-5.6 Sol with high reasoning via OpenAI Responses and Cloudflare AI Gateway BYOK
- **Embeddings**: Workers AI `@cf/baai/bge-base-en-v1.5` (768 dims) through the `AI` binding
- **PDF**: Browser Rendering (`@cloudflare/puppeteer`, `page.pdf()`) through the `BROWSER` binding
- **Printing**: Lulu Print API (sandbox, then production)
- **Graph UI**: d3-force layout, React SVG nodes
- **Read caching**: Workers Cache driven by `Cache-Control`
- **Auth**: Cloudflare Access on write endpoints and private paths
- **Email**: Cloudflare Email Service (later: digest, suggestions, order status)

```
Matter API ──daily──▶ MatterSyncWorkflow ──writes──▶ R2 sources/ + embeddings.json + index.json
                             │ archived & not synthesized
                             ▼
                      SynthesisWorkflow ──LLM tool loop──▶ R2 wiki/  (citations → index.json edges)

Browser ──▶ Worker (SSR from R2, edge-cached) ──▶ graph / topic / source / book pages

/book ──▶ BookWorkflow: plan (LLM) → interior.html → Browser Rendering → interior.pdf
                        → Lulu cover dims → cover.pdf → quote → confirm → print job → status
```

## External APIs

**Matter** (`https://api.getmatter.com/public/v1`, Bearer `mat_…`, Pro required, one active token):
- `GET /items?status=queue,archive&order=updated&updated_since=<iso>&limit=100&cursor=` — incremental sync
- `GET /items/{id}?include=markdown` — article body, 20 requests/min
- `POST /items {url, status}` — later, for suggestions
- Limits: 120 reads/min, 5/s burst. No webhooks. No publish date in the item.
- Item fields used: `id`, `title`, `url`, `site_name`, `author.name`, `status`, `processing_status`, `content_type`, `word_count`, `reading_progress`, `excerpt`, `is_favorite`, `library_position`, `updated_at`. Inline article images are hosted on `media.getmatter.app`; Matter's 600×600 hero thumbnails (`image_url`) are not used.

**Lulu** (`https://api.lulu.com`, sandbox `https://api.sandbox.lulu.com`, OAuth2 client credentials):
- `POST /calculate-cover-dimensions/ {pod_package_id, interior_page_count, unit}`
- `POST /print-job-cost-calculations/`
- `POST /print-jobs` with `line_items[{ printable_normalization: { interior.source_url, cover.source_url, pod_package_id }, quantity, title }]`, `shipping_address`, `shipping_level`
- `GET /print-jobs/{id}/status/`
- Package id encodes trim, color, paper, binding, e.g. `0600X0900.BW.STD.PB.060UW444.MXX` (6×9, B&W, paperback).

## R2 layout

```
sources/<matterId>.md     one per queue/archive item; frontmatter below, body = Matter markdown
wiki/<slug>.md            synthesized topic pages
index.json                everything the graph and the LLM need (schema below)
embeddings.json           vectors, read only by the sync job
sync.json                 { cursor: <updated_since ISO>, lastRun }
log.md                    append-only record of syncs, syntheses, book builds
history/<slug>/<ts>.md    previous versions of topic pages, copied on every write
books/<bookId>/           manifest.json · interior.html · interior.pdf · cover.pdf · status.json
```

## Schema

### Source frontmatter (`sources/<id>.md`)

```yaml
matter_id: itm_8MQYb
title: A farewell to the craft
url: https://github.com/facundoolano/style-guide
site: github.com
author: Facundo Olano          # optional
content_type: article          # article | pdf | podcast | video | tweet | newsletter
word_count: 4364               # optional
state: archived                # queued | reading | archived
progress: 1.0                  # Matter reading_progress, kept for all states, meaningful for reading
favorite: false
excerpt: …                     # optional
archived_at: 2026-08-20T…      # set the first sync that sees state=archived
synthesized_at: 2026-08-21T…   # set by SynthesisWorkflow; absent until then
matter_updated_at: 2026-08-20T…
```

State derives from Matter: `archive` → `archived`; `queue` with `reading_progress > 0` → `reading`; otherwise `queued`. Inbox items are never fetched.

### Topic page frontmatter (`wiki/<slug>.md`)

```yaml
title: Home servers
aliases: homelab, home lab     # optional, comma-separated
```

Body conventions: `[[wiki-links]]` to other topic pages (resolved via aliases), `[[source:itm_…]]` citations.

### `index.json`

```ts
{
  pages: { slug, title, summary, links: slug[], cites: matterId[] }[],
  sources: (SourceFrontmatter & {   // same fields and names as the source frontmatter above
    near: slug[]               // nearest topic pages by embedding, only for non-archived
  })[],
  aliases: Record<string, slug>
}
```

Graph edges are derived: `pages[].links` (page→page), `pages[].cites` (page→source, solid), `sources[].near` (source→page, dotted, only while not archived). The LLM prompt sees `pages` without `links`/`cites` plus a compact `sources` list.

### `embeddings.json`

```ts
{ model: "@cf/baai/bge-base-en-v1.5", dims: 768,
  vectors: Record<string /* matterId | "wiki:"+slug */, { text: string, vector: number[] }> }  // text kept to detect stale vectors
```

Input text: `title + "\n" + excerpt` for sources, `title + "\n" + summary` for topic pages, cls pooling. `regenerateIndex` embeds whatever is missing or changed and fills `near` (top 2 pages with cosine ≥ 0.65) for non-archived sources, so every write path gets edges for free. Nearest-neighbour is brute-force cosine in the Worker; at personal scale (hundreds to low thousands of vectors) this is milliseconds. Upgrade path if it ever matters: Vectorize.

## Workflows

Every background job is a Workflow: each action is a `step.do` checkpoint, LLM waits cost no CPU, dynamic step counts are supported, and cron is a `schedules` entry on the binding. Step params and results must be serializable and ≤ 1 MiB, so steps pass ids and summaries, never article bodies.

**`MatterSyncWorkflow`** — cron daily, also triggerable from `/api/sync`.
1. Read `sync.json` cursor.
2. Page `GET /items?status=queue,archive&order=updated&updated_since=cursor`.
3. For each item: compute state; if new, fetch markdown (one step per item, `step.sleep` to stay under 20/min) and embed; write `sources/<id>.md` (metadata always, body only on first sight or when `processing_status` changed).
4. For non-archived items, recompute `near` against topic-page vectors.
5. Regenerate `index.json`. Advance cursor.
6. For each source with `state=archived` and no `synthesized_at`, create a `SynthesisWorkflow` instance, capped per run by `MAX_SYNTHESES_PER_RUN`.

First run has no cursor and backfills everything (47 archived, 86 queued today).

**`SynthesisWorkflow`** — one archived source. The existing tool loop (`read_page`, `write_page`) plus `read_source`. Input: index projection, the source page. Output: topic pages written through the write seam; source marked `synthesized_at`; topic-page embeddings refreshed; log entry.

**`BookWorkflow`** — on demand from `/book`.
1. Selection → LLM plans chapters (`manifest.json`: chapters keyed by topic slug, ordered source ids).
2. Render `interior.html` (print CSS: `@page` size and margins, running heads, page numbers, TOC, chapter intro = topic page body, article title blocks) → Browser Rendering → `interior.pdf`; read page count.
3. Lulu cover dimensions → `cover.html` → `cover.pdf`.
4. Lulu cost quote → `status.json` → `step.waitForEvent("confirm")`.
5. Lulu print job with signed R2 URLs for both PDFs → poll status → email.

## Write seam

All content writes go through `writePage` / `writeSource`: copy previous version to `history/` (topic pages only), write to R2, regenerate `index.json`, purge affected cache URLs. Git mirror via the GitHub Git Data API remains a later addition behind the same seam.

## Frontend

React Router v8 framework mode on Workers (see git history for the Astro/SPA comparison). Routes:

- `/` graph + list. Loader reads `index.json`; the client runs d3-force and draws SVG nodes per the state vocabulary in DESIGN.md.
- `/wiki/:slug` topic page (SSR from R2, edge-cached).
- `/source/:id` source page (private).
- `/book` builder; `/api/book/*` create, confirm, status; `/api/sync` manual trigger; `/api/reindex`.

Removed from the previous design: input box, `api/input`, `api/jobs`, red-link streaming route, `ResumableStreamDO`.

## Auth & visibility

Cloudflare Access gates `/book`, `/source/*`, and every `/api/*` route, using the **One-time PIN** login method (email code, no Google or other SSO; free on the Zero Trust plan). Allow rule: my email only. Access requires the app to be on a custom domain in the account. Topic pages and the graph are publicly readable with no auth; public renders cite the original article URL rather than the private source page.

## Secrets and bindings

Secrets: `CF_AIG_TOKEN`, `MATTER_API_TOKEN`, `LULU_CLIENT_KEY`, `LULU_CLIENT_SECRET`. Vars: `OPENAI_BASE_URL`, `OPENAI_MODEL`, `LULU_BASE_URL`, `BOOK_POD_PACKAGE_ID`, `MAX_SYNTHESES_PER_RUN`. Bindings: `WIKI` (R2), `AI`, `BROWSER`, workflows `MATTER_SYNC`, `SYNTHESIS`, `BOOK`. Browser Rendering requires the Workers Paid plan.

## Milestones

1. **Sync + graph**: `MatterSyncWorkflow`, source pages, embeddings, `index.json` with sources and `near`, graph view with the state vocabulary. No LLM. Verify: run sync, see the library as correctly labeled nodes.
2. **Synthesis**: `SynthesisWorkflow` on archived sources, citations, topic pages. Remove input-box and red-link code. Verify: archive an item in Matter → next sync → a topic page cites it.
3. **Book PDFs**: `BookWorkflow` through interior and cover PDF download. Verify: open PDFs, check size and bleed against Lulu's template.
4. **Lulu order**: cover dimensions, quote, sandbox order, status, email. Then production.
5. **Upkeep**: lint, digest, suggestions with save-to-Matter.
