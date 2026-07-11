# Architecture

How [DESIGN.md](DESIGN.md) maps onto Cloudflare. DESIGN.md says *what*; this says *with which primitives and why*. Decisions here were made against docs current as of July 2026.

## Stack at a glance

- **App**: React Router v8 (framework mode) + shadcn/ui + Tailwind, deployed to Workers via `@cloudflare/vite-plugin`
- **Content store**: R2 (markdown, images, index/graph JSON) — the live copy
- **Jobs**: Cloudflare Workflows (synthesis, red-link generation, Matter polling, lint, digest)
- **LLM**: GPT-5.6 Sol with high reasoning via OpenAI Responses and Cloudflare AI Gateway BYOK (direct OpenAI billing, metadata-only gateway logs)
- **Read caching**: Workers Cache (`"cache": {"enabled": true}`) driven by `Cache-Control` headers
- **Auth**: Cloudflare Access on write endpoints and private paths; wiki pages publicly readable
- **Email**: Cloudflare Email Service `send_email` binding (digest)
- **History**: R2 previous-version copies day one; GitHub mirror via Git Data API later

```
Browser / crawler
   │
   ▼
Worker (React Router SSR)
   ├─ read: R2 .md → render → HTML, Cache-Control → edge-cached (cache hits skip the Worker)
   ├─ write: input box POST → Workflow instance created → returns instantly
   └─ toast: UI polls workflow status endpoint
   
Workflows (one durable step per LLM call / R2 read / R2 write / web fetch)
   ├─ LLM calls → AI Gateway → OpenAI Responses
   └─ on finish: write pages via the write seam, regenerate index.json + sitemap, purge cache

Write seam (single function all writes go through)
   ├─ copy previous version → history/ (undo)
   ├─ write .md to R2
   ├─ regenerate index.json / sitemap.xml
   ├─ purge affected URLs from edge cache
   └─ [later] enqueue git mirror commit
```

## Frontend

**React Router v8 framework mode on Workers**, with shadcn/ui.

- Why not plain Worker-rendered HTML: the interactive surface (persistent input box, toasts, highlight-selection popup, graph view, status line) shares state across every page — one React tree fits it; shadcn requires React anyway.
- Why not Astro: shadcn components become islands needing cross-island state plumbing; Astro's zero-JS advantage evaporates once React ships. (Astro 6 + adapter v13 is the runner-up.)
- Why not a SPA: crawlers and first-paint get an empty shell; the rendered page is never edge-cacheable as HTML. Worst fit for a read-heavy wiki.
- R2 bindings in loaders via the `cloudflare:workers` `env` import. Dev runs in real workerd via the Vite plugin.

**Reading feels static** because SSR responses carry `Cache-Control` and Workers Cache serves hits without executing the Worker. The build step builds only the shell; content is rendered from R2 per request (then cached), so a synthesis write is visible in seconds and content never waits on a deploy.

## R2 layout

```
wiki/<slug>.md          synthesized articles (mutable)
sources/<slug>.md       ingested content (immutable, always private)
images/<id>             stored uploads/ingested images
index.md                the map (human + LLM entry point)
index.json              graph data, alias→slug map, page summaries
log.md                  append-only ingest/synthesis/lint record
history/<slug>/<ts>.md  previous versions, copied on every write (undo)
sitemap.xml             regenerated on write, from index.json
```

## Jobs: Workflows, not Queues

Every background job is a Workflow. Rationale:

- Jobs are multi-step agent loops (read index → read pages → several OpenAI calls → write several files). Each action is a `step.do` checkpoint — a flake at step 6 doesn't redo steps 1–5. A Queue consumer would retry the whole job.
- Wall-clock per step is unlimited and awaiting an LLM response costs no CPU. Dynamic step counts (agent decides how many turns) are explicitly supported.
- Cron is built in: workflow bindings take a `schedules` array — Matter polling, lint, and digest are cron expressions, no scheduled handler.
- Constraint to design around: step params/results must be serializable and ≤ 1 MiB — carry slugs and summaries between steps, not blobs.

Workflows in v1:

- `SynthesisWorkflow` — input-box submissions and red-link generation (same machinery, different trigger)
- `MatterPollWorkflow` — cron; polls Matter highlights feed, enqueues ingests
- `LintWorkflow` — cron; mechanical self-heals + judgment calls surfaced to digest
- `DigestWorkflow` — cron; renders digest from log/history, sends via Email Service

**Toast**: v1 polls the workflow instance `status()` via a lightweight endpoint. Upgrade path: one Agents SDK Durable Object holding a WebSocket, using its `onWorkflowProgress` → `broadcast()` hook. Add only if polling latency annoys.

## LLM access

The agent is a tool-use loop inside a Workflow with R2-backed tools (`read_index`, `read_page`, `write_page`) — no vector DB, no sandbox (per DESIGN.md). Calls use the OpenAI Responses API through an authenticated **AI Gateway**. The OpenAI service key lives in Cloudflare Secrets Store as the gateway's `default` BYOK key, so the Worker holds only a scoped AI Gateway Run token and OpenAI bills the project directly. Responses use `store: false`; gateway caching is bypassed and logs retain request metadata without prompt or response payloads.

## Auth & visibility

- **Cloudflare Access** gates write endpoints (input box, highlight actions) and all private paths. No auth code in the app.
- **Wiki pages are publicly readable** (indexable): SSR HTML + sitemap.xml + per-page meta make crawling work. Storage location (R2) is irrelevant to crawlability — crawlers see only what the Worker returns to an anonymous GET.
- **Source pages stay private always**: they are copies of other people's articles; republishing is a copyright problem. Public wiki pages cite the original URL instead of the source page for anonymous readers.
- Personal provenance ("from your note on …") on public renders: decide per-page; default to omitting quotes of my notes from anonymous views.
- Flipping the whole site private (or per-page `public:` frontmatter flags, DESIGN.md v2) is a middleware change, not an architecture change.

## History & git mirror

R2 keeps no object history, and the agent edits autonomously with no approval flow — history is the safety net.

- **Day one**: the write seam copies the previous version to `history/` before overwriting. Crude undo, kills the "LLM destroyed my page" risk without GitHub.
- **Later (still in the design, cut from milestone 1)**: mirror to a GitHub repo via the **Git Data API** (blobs → tree → commit → ref = one atomic multi-file commit per synthesis job; no git binary needed). Fine-grained no-expiry PAT scoped to the mirror repo, stored as a Worker secret. Rate limits are a non-issue at personal volume.
- **Revert** is app-initiated, not webhook-driven: a "restore version" action reads the old content (history/ or GitHub) and writes it back through the write seam, which mirrors forward as a new commit. No bidirectional sync.
- The mirror is also the escape hatch: cloneable snapshot, portability, and the substrate for heavy whole-corpus maintenance (clone + run a coding agent against the filesystem — locally or in a Cloudflare Sandbox container; that's the sandbox's only slot in this system, and it's v2+).

## Email

Digest via the Email Service `send_email` binding from `DigestWorkflow`. Sending to my own verified address is free and quota-exempt. Service is Beta; Resend is a ~20-line swap if it misbehaves.

## Git mirror ≠ deploys

Two unrelated git repos:

- **This repo** (app code): deploys via `wrangler deploy` on push. Code path only.
- **Mirror repo** (wiki content): written by the app, never deployed from.

## Milestones

1. **Spine**: React Router app on Workers + R2 read path (markdown → SSR HTML → edge cache) + input box → `SynthesisWorkflow` end-to-end (one page written, toast fires). Write seam with history/ copies. Access on writes.
2. **Graph & links**: index.json regeneration, graph view, red links, dedup/alias resolution, eager one-layer generation.
3. **Ingestion**: Matter polling workflow, source pages, highlight-quote popup.
4. **Upkeep**: lint workflow, digest email, sitemap/meta polish.
5. **Deferred**: GitHub mirror, WebSocket toast, sandbox maintenance path, per-page visibility flags.

## Open design problems (not blockers)

- **Dedup/alias resolution** (DESIGN.md calls it the hard problem): lean — aliases in page frontmatter, flattened alias→slug map in index.json, every link the synthesizer writes resolves against it via a cheap-model pass. Needs its own design pass before milestone 2.
- **Eager red-link generation cost dial**: consider "eager only for pages opened from the graph" if cost bites; provider-side project limits are the billing backstop.
- DESIGN.md's open trio: digest cadence, Matter auto-ingest vs confirm, highlight popup actions.
