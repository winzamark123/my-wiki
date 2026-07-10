# Personal Wiki — Design Spec

Inspired by [Karpathy's llm-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): the wiki is a persistent, compounding artifact. Knowledge is synthesized once at creation time, not re-derived at query time. The LLM does all the bookkeeping; the human curates attention and asks questions.

Private, single-user, tailored to what *I* want to read and explore. Intersection topics ("home server × computer use") are first-class — this is not an encyclopedia, it's a map of my curiosity.

## Core principles

- **Frontload everything.** Links, citations, images, and cross-references are built at ingestion/creation time. Reading requires no LLM in the loop.
- **Attention-gated growth.** Nothing enters the wiki because it was saved or collected — only because I highlighted it, dropped it in the input box, or opened a page. Prevents the read-it-later graveyard from leaking into the wiki.
- **Zero human writing.** All content is AI-generated, backed by sources, web search, or my inputs. My fingerprint is what I paid attention to and what I said — captured as provenance, never as authored prose.
- **The page is the response.** There is no chatbot. Inputs materialize as page content; the artifact is the reply.

## Architecture (Karpathy's three layers)

1. **Sources** — immutable ingested content (articles, my inputs, images). Rendered as readable *source pages*. My highlight-triggered inputs are persisted here too: they are the only place I exist in the system, and pages cite them as provenance ("from your note on 2026-07-09").
2. **Wiki** — synthesized markdown articles. Mutable, densely internally-linked, written in blog/article voice (narrative, readable — not terse notes). One representation serves both human reading and LLM context.
3. **Schema** — a config document defining page conventions, linking rules, voice, and the ingest/query/lint workflows. Turns the LLM into a disciplined wiki maintainer.

Everything is markdown in git. Version history = free revert for auto-committed changes.

## Surfaces

### Wiki pages
Blog-style articles with embedded images (from ingested sources) and internal-only links. Claims carry citations linking to source pages, anchored to the relevant passage where possible.

### Source pages
Ingested external content rendered readably. Immutable. Clearly visually distinct from wiki pages (someone else's voice vs. synthesized).

### Graph / index page
The navigation home; the human-facing render of `index.md`.
- **Graph view**: nodes and links, Obsidian-style. Red links render as hollow/distinct nodes (the curiosity frontier). Orphans are visibly disconnected. Doubles as a health dashboard.
- **List view**: categorized table of contents, one-line summary per page.

## The input box

A persistent input at the bottom-right of every page. **Not a chat.** Fire-and-forget: whatever is dropped in gets synthesized in the background.

- Accepts **text** (instructions or raw information), **links** (fetched and ingested as source pages — dropping a link here is the attention signal), **images** (stored locally, embedded, captioned).
- The current page is the *default context*, but the synthesizer decides placement: weave into this page, update another page, or create a new page. Never blind-append — pages are synthesis, not journals.
- On completion, a **toast** reports what happened: "Synthesized into *X* · created *Y*" — each a link to the page.
- A new topic is just an empty page + the same input box. No special creation flow.
- One thin non-page channel: an ephemeral status line above the input for things that can't be content ("couldn't fetch that link", "this contradicts *Proxmox* — which is right?"). Not a transcript.

### Highlight interaction
Highlighting text (on wiki *or* source pages) shows a small popup above the selection (Codex-chat style) with quick options. Primary action: **quote into the input box** — the next input applies to that passage ("expand this", "this is outdated", "make this its own page"). Same gesture on both surfaces; the layer determines meaning (source highlight = ingestion signal, wiki highlight = edit instruction).

## Ingestion

- **Matter (v1)**: poll Matter's highlights API (`api.getmatter.app/api/v11/library_items/highlights_feed`, QR-code auth — same API their Obsidian plugin uses). Highlighted articles become ingestion candidates; we fetch the full article ourselves. The wiki learns both the source and which passages I cared about. No extension needed.
- **Direct**: links/files/images dropped into the input box.
- Saving to Matter ≠ ingestion. Highlights are the gate.
- An ingest touches many pages: summary/source page, updates to relevant wiki pages, index update, log entry.

## Red links & generation

Links are internal-only and written liberally — including to pages that don't exist yet. A red link is not an error; the set of red links is the reading queue.

- **Eager, one layer deep**: opening a page queues background generation of its red links, so they're ready by the time I click. Newly generated pages' own red links stay red until *that* page is opened. The frontier expands one step ahead of reading — infinite generation is structurally impossible.
- **Cap ~10–15 links per page** — bounds cost and forces linking what matters.
- **Dedup is the hard problem**: every link resolves against the index with aliases ("computer use" = "CUA" = "computer-use agents") before a new red link is created. Sloppy dedup fragments the graph into near-duplicates.
- **Context-rich births**: a red-link page is generated from the paragraph(s) that reference it + related wiki pages + web search — never from the title alone. Links accumulated from multiple pages give the generation multiple contexts.

## Maintenance

- **Auto-commit + changelog.** Changes apply immediately (git for revert). No approval flow.
- **Digest email** (daily/weekly): pages created/updated, contradictions found, unexplored red links. Doubles as the pull-back-into-reading mechanism.
- **Lint** (periodic): self-heals mechanical issues (missing backlinks, index drift); surfaces judgment calls (contradictions, stale claims superseded by newer sources) to me. When a new page lands, older pages get re-linked into it — frontloading is ingestion-time *plus* periodic re-linking.
- **log.md**: append-only record of ingests, syntheses, and lint passes.

## Scope

**v1**: wiki pages, source pages, graph/index, input box + highlight-quote, Matter ingestion, red-link generation, lint, digest email.

**v2+**: own reader extension (replace Matter entirely — read, highlight, and build in one platform), generated diagrams, public visibility flags per page.

## Open questions

- Digest cadence: daily or weekly?
- Matter highlights: auto-ingest anything highlighted, or require explicit confirmation per article?
- Highlight popup: which quick actions beyond "quote into input"? (candidates: expand, make-new-page)
