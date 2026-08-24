# Architecture

How [DESIGN.md](DESIGN.md) maps onto Cloudflare. DESIGN.md says *what*; this says *with which primitives and why*. Decisions here were made against docs current as of August 2026.

## Stack at a glance

- **Server** (`apps/server-app`): one Worker that owns every binding (R2, Workers AI, Workflows, cron) and serves an HTTP JSON API. Everything that talks to Matter or R2 lives here.
- **App** (`apps/app`): React Router v8 (framework mode) + shadcn/ui + Tailwind, deployed to Workers via `@cloudflare/vite-plugin`. Reads from the server API only; no data bindings of its own.
- **API contract**: Zod schemas exported by `server-app` and parsed by `app`. The runtime contract is HTTP JSON, so external clients do not depend on workspace code.
- **Content store**: R2 (markdown, index, embeddings, book files)
- **Jobs**: Cloudflare Workflows (Matter sync, book build; later digest and suggestions)
- **Links**: Workers AI through the `AI` binding: `@cf/baai/bge-m3` embeddings (1024 dims), `@cf/baai/bge-reranker-base`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for link labels
- **PDF**: Browser Rendering (`@cloudflare/puppeteer`, `page.pdf()`) through the `BROWSER` binding
- **Printing**: Lulu Print API (sandbox, then production)
- **Graph UI**: d3-force layout, React SVG nodes
- **Read caching**: Workers Cache driven by `Cache-Control`
- **Auth**: none until the book flow works end to end (M5); then Cloudflare Access on the web app's private paths and a bearer token between web and server
- **Email**: Cloudflare Email Service (later: digest, suggestions, order status)

```
                 ┌──────────── server (apps/server-app) ───────────────┐
Matter API ──daily──▶ MatterSyncWorkflow ──writes──▶ R2 sources/ + embeddings.json + links.json + index.json
                 │  GET /api/index · GET /api/sources/:id · POST /api/sync · /api/book/*   │
                 └───────────────────────────▲──────────────────────────┘
                                             │ HTTP JSON
Browser ──▶ app (apps/app): SSR graph / source / book pages ─┘
Portfolio site ──▶ GET /api/index (public, read-only) ───────┘

/book ──▶ BookWorkflow (server): plan → interior.html → Browser Rendering → interior.pdf
                                 → Lulu cover dims → cover.pdf → quote → confirm → print job → status
```

## Apps

The repo is a pnpm workspace with two Workers:

```
apps/server-app/  Worker my-wiki-server-app: R2, AI, Workflows, cron, HTTP API. All Matter and R2 access.
apps/app/         Worker my-wiki-app: the React Router UI. Loaders call the server API over HTTP.
```

The server exports the Zod schemas for its API responses. The app imports those schemas to validate responses, but all runtime communication is HTTP. Add `packages/db` only if a real D1 or PostgreSQL schema and migration tooling arrive; R2 access remains private to `server-app`.

The rule: if code reads Matter, reads or writes R2, or calls a model, it is in the server. The app is one client of the server; it gets no special access. Two reasons:

1. Other clients will read the same data from other deployments. The first is a "my readings" page on my portfolio site, which needs only the public graph.
2. More than one person will use it. Each user will add their own Matter token, and the server will sync each library on its own schedule (see Multi-user below).

### Server API

| Route | Returns |
| --- | --- |
| `GET /api/index` | `index.json` with `excerpt` removed; `Cache-Control: public, max-age=0, s-maxage=60` |
| `GET /api/sources/:id` | `{ meta, body }`; body is the Matter markdown, rendered by the client |
| `POST /api/sync?full=1` | `{ id }` of the new `MatterSyncWorkflow` instance |
| `GET /api/sync/:id` | instance status |
| `POST /api/reindex` | dev only: rebuild index, embeddings, links |
| `/api/book/*` | added in M3 |

No auth until M5: the whole thing runs in dev until the book flow works end to end. The server can still be deployed on its own before that: with `workers_dev` off and no custom domain, no route is reachable, but the cron fires and fills R2. Hono defines the API routes. CORS is added before the first browser client calls the public index directly.

The app reads `SERVER_URL` from its vars (`http://localhost:8787` in dev). A service binding from app to server is possible later for latency, but HTTP is the only contract so every client is treated the same.

Local development runs both Workers. Only `server-app` has a local R2 store.

### Multi-user (milestone M7)

- Identity: Cloudflare Access with One-time PIN on the web app, allow rule widened from one email to a list. The web app forwards the `Cf-Access-Jwt-Assertion` header; the server verifies the JWT against the team's public keys and uses the email as the user id.
- Matter token: `PUT /api/me/matter-token`, validated with one `GET /items?limit=1` call, then stored AES-GCM encrypted (key in the `TOKEN_KEY` secret) in `users/<id>/settings.json`. The `MATTER_API_TOKEN` Worker secret goes away.
- Data: every R2 key moves under `users/<id>/`; the flat layout below is the single-user form. `GET /api/index` becomes `GET /api/users/:id/index`.
- Cron: the scheduled handler lists users and starts one `MatterSyncWorkflow` per user with `{ userId }`. Matter rate limits are per token, so user syncs do not compete.

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
index.json                everything the graph needs (schema below)
embeddings.json           one vector per source, read only by the sync job
links.json                every judged pair with its label (or null when rejected)
sync.json                 { cursor: <updated_since ISO>, lastRun }
log.md                    append-only record of syncs and book builds
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
matter_updated_at: 2026-08-20T…
```

State derives from Matter: `archive` → `archived`; `queue` with `reading_progress > 0` → `reading`; otherwise `queued`. Inbox items are never fetched.

### `index.json`

```ts
{
  sources: SourceFrontmatter[],            // same fields and names as the source frontmatter above
  links: { a: matterId, b: matterId, label: string }[]   // one entry per related pair
}
```

### `embeddings.json`

```ts
{ model: "@cf/baai/bge-m3", dims: 1024,
  vectors: Record<matterId, { hash: string, vector: number[] }> }   // sha-256 of the embedded text detects stale vectors
```

### `links.json`

```ts
{ pairs: Record<"a|b" /* sorted ids */, { label: string | null }>,   // null = judged and rejected, never asked again
  evaluated: Record<matterId, hash> }                                 // which text each source was last linked with
```

## Links

Links are computed at sync time, per source, in three stages, all through the `AI` binding:

1. **Candidates.** The source's embedding (title + full body, images and link targets stripped, up to 8192 tokens) is compared with every other vector by cosine; the top 8 are candidates. Brute force in the Worker; at personal scale this is milliseconds. Upgrade path if it ever matters: Vectorize.
2. **Rerank.** `bge-reranker-base` reads the source and each candidate together (the first ~1,500 characters of each) and scores them 0–1. Keep up to 4 with score ≥ 0.2.
3. **Verdict and label.** Llama 3.3 70B gets the same heads and returns JSON per candidate: related or not, plus a label of at most 8 words saying what they share. Accepted pairs get the label; rejected pairs are stored with `null`.

A source is (re)linked when its embedded text hash changes, which happens once: when the body is first fetched. Every pair is judged once, from whichever side saw it first, so the LLM cost is per new article, not per sync. The graph draws `index.json.links` and shows the label on hover; the source page lists them under Related. Tunables live at the top of `apps/server-app/src/links.server.ts`.

## Workflows

Every background job is a Workflow: each action is a `step.do` checkpoint, dynamic step counts are supported, and cron is a `schedules` entry on the binding. Step params and results must be serializable and ≤ 1 MiB, so steps pass ids and summaries, never article bodies.

**`MatterSyncWorkflow`** — cron daily, also triggerable from `/api/sync`.
1. Read `sync.json` cursor.
2. Page `GET /items?status=queue,archive&order=updated&updated_since=cursor`.
3. For each item: compute state; if new, fetch markdown (spaced to stay under 20/min); write `sources/<id>.md` (metadata always, body only on first sight).
4. Regenerate `index.json`: embed new or changed sources, return the ids not yet linked.
5. Link those ids in steps of 5 (each costs a reranker call and an LLM call), then regenerate `index.json` again so it carries the new links. Advance cursor.

First run has no cursor and backfills everything (47 archived, 86 queued today).

**`BookWorkflow`** — on demand from `/book`.
1. Selection → chapter plan (`manifest.json`: chapters with a title and ordered source ids). Grouping by embedding similarity; whether a model titles the chapters is open (DESIGN.md → Open questions).
2. Render `interior.html` (print CSS: `@page` size and margins, running heads, page numbers, TOC, chapter title pages, article title blocks) → Browser Rendering → `interior.pdf`; read page count.
3. Lulu cover dimensions → `cover.html` → `cover.pdf`.
4. Lulu cost quote → `status.json` → `step.waitForEvent("confirm")`.
5. Lulu print job with signed R2 URLs for both PDFs → poll status → email.

## Writes

Sources are written by the sync job only (`writeSource`); `index.json`, `embeddings.json`, and `links.json` are updated once per sync. Only the server touches R2. Source pages are served with `no-store`; the graph is edge-cached for 60 s, so a sync is visible within a minute. Cache purge on write is a later addition.

## App

React Router v8 framework mode on Workers (see git history for the Astro/SPA comparison). Routes:

- `/` graph + list. Loader calls `GET /api/index`; the client runs d3-force and draws SVG nodes per the state vocabulary in DESIGN.md.
- `/source/:id` source page with its Related list (private). Loader calls `GET /api/sources/:id` and renders the markdown with `marked`.
- `/book` builder (M3), backed by the server's `/api/book/*`.

The loaders call `server-app` over HTTP and validate each JSON response against the server's Zod schemas. The app has no R2, AI, Workflow, cron, or Matter bindings.

Removed from earlier designs: input box, red-link generation, LLM-written topic pages, `/wiki/:slug`.

## Auth & visibility

Nothing is public before M5; both Workers keep `workers_dev` off and have no custom domain. When the site goes live: Cloudflare Access gates the web app's `/book*` and `/source/*` paths, using the **One-time PIN** login method (email code, no Google or other SSO; free on the Zero Trust plan). Allow rule: my email only. Access requires the app to be on a custom domain in the account. The graph is publicly readable with no auth; it shows titles and sites only, and its nodes link to private source pages.

The server is not behind Access. `GET /api/index` is public; every other route checks an `API_TOKEN` bearer that the web app sends server side. Browsers never call the private server routes directly.

## Secrets and bindings

Server secrets: `MATTER_API_TOKEN` (until M7), `LULU_CLIENT_KEY`, `LULU_CLIENT_SECRET`, and from M5 `API_TOKEN`; vars `LULU_BASE_URL`, `BOOK_POD_PACKAGE_ID`; bindings `WIKI` (R2), `AI`, `BROWSER`, workflows `MATTER_SYNC`, `BOOK`. Browser Rendering requires the Workers Paid plan.

App vars: `SERVER_URL`; from M5 the `API_TOKEN` secret. No data bindings.

## Milestones

Tracked in Linear (project my-wiki). Each milestone's issues are ordered by blocking relations; an issue that blocks nothing can run in parallel.

1. **Sync + graph**: `MatterSyncWorkflow`, source pages, embeddings, `index.json` with labeled links, graph view with the state vocabulary. Verify: run sync, see the library as correctly labeled nodes. Done.
2. **Server + client split**: workspace layout, `apps/server-app` with the API and all bindings, `apps/app` reading over HTTP, CORS for external clients. Verify: both Workers run locally, the graph and source pages render from the API, and the app has no data bindings.
3. **Book PDFs**: `BookWorkflow` through interior and cover PDF download, all in dev. Verify: open PDFs, check size and bleed against Lulu's template.
4. **Lulu order**: cover dimensions, quote, sandbox order, status, email. Then a production order from dev and a physical proof.
5. **Access + deploy**: only after the wiki-to-book flow works end to end. Custom domain for both Workers, Access with One-time PIN on web, `API_TOKEN`, first production sync.
6. **Upkeep**: digest, suggestions with save-to-Matter.
7. **Multi-user**: identity from the Access JWT, per-user Matter token, per-user data prefix and cron fan-out.
