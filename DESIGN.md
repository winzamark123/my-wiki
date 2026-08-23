# Reading Wiki — Design Spec

A graph of everything I read in [Matter](https://getmatter.com), synthesized into topic pages by an LLM, and printable as a physical book. Inspired by [Karpathy's llm-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): knowledge is synthesized once at ingestion time, not re-derived at query time. The LLM does the bookkeeping; I only read.

Private, single-user. Matter is the only input. There is no input box, no chat, and no manual page editing.

## Core principles

- **Matter is the only input.** Nothing enters the wiki except through my Matter library. Saving to the queue adds a node; archiving triggers synthesis. There is no other way in.
- **Archive is the gate.** Only finished reading is synthesized. Queued and in-progress items are visible in the graph as the frontier, but the LLM never writes about them.
- **Frontload everything.** Topic pages, citations, and graph edges are built when an item is archived. Reading the wiki requires no LLM in the loop.
- **Zero human writing.** All prose is LLM-generated from sources. My fingerprint is what I chose to read and finish.
- **The book is the output.** The wiki exists so that, at some point, it can be laid out and printed. Everything in the data model serves that.

## States

Matter has an inbox (a feed of writers and newsletters I follow), a queue (things I saved myself), and an archive. The wiki ignores the inbox; swiping an item to the queue in Matter is the act that adds it to the wiki.

| Wiki state | Matter condition | Shown as |
| --- | --- | --- |
| `queued` | in queue, `reading_progress = 0` | hollow dotted circle |
| `reading` | in queue, `reading_progress > 0` | ring with an arc covering the progress |
| `archived` | in archive | solid circle; progress is ignored |

Archive means finished regardless of progress; many items are archived without scrolling to the end.

## Architecture (three layers)

1. **Sources** — one page per Matter item: metadata, state, progress, and the article body as Matter delivers it. Immutable apart from state changes. Private (copies of other people's writing).
2. **Wiki** — synthesized topic pages in markdown. Mutable, densely linked, blog-style prose. Every claim cites a source. One representation serves the reader, the LLM, and the book.
3. **Schema** — the conventions the LLM follows (page format, linking, citation, voice) and the data shapes in ARCHITECTURE.md.

## Surfaces

### Graph (home)
Force-directed graph of every source and topic page.

- **Sources** are circles, drawn by state as above. Radius scales with word count. Favorites carry a small amber dot.
- **Topic pages** are diamonds in the accent color.
- **Citation edges** (solid) run from archived sources to the topic pages that cite them, and between topic pages that link each other.
- **Similarity edges** (dotted) attach queued and reading items to their nearest topic pages, computed from embeddings. They disappear when the item is archived and real citations replace them.
- Filters: by state, by favorite, by site, by word count. Each is a predicate on the index.

A list view shows the same data as a categorized table of contents.

### Topic page
Blog-style article with inline citations to source pages and `[[wiki-links]]` to other topic pages. Links to pages that don't exist yet render as plain text; there is no red-link generation.

### Source page
The Matter item rendered readably: title, author, site, state, progress, word count, and the article body. Visually distinct from topic pages. Never public.

### Book builder
Select sources (all archived, by topic, or by date range), preview the chapter plan, see a price quote, and order. Details under Book.

## Ingestion

A daily job pulls every queue and archive item from the Matter API using `updated_since`, so each run fetches only what changed.

- New items get a source page with metadata and state. The article body (`?include=markdown`) is fetched once.
- State and progress updates rewrite the source frontmatter; the graph reflects them on the next render.
- Items that moved to `archived` and have not been synthesized are handed to synthesis.
- Each new item is embedded (title + excerpt) for similarity edges. Topic pages are embedded when written.
- Highlights and annotations are not fetched. Tags are not used.

Matter hosts article images on its own CDN; the wiki and the book load images by URL and store no copies.

## Synthesis

Runs once per archived source. The LLM reads the index and the source, opens related topic pages, and decides placement: weave into an existing page, update several, or create a new one. Never blind-append. Pages are synthesis, not journals.

- Topic pages link liberally (10–15 `[[wiki-links]]` max per page) and resolve every link against the alias map before creating a new target. Near-duplicate topics are the failure mode to avoid.
- Every source-derived claim cites `[[source:<id>]]`. Citations are the graph's solid edges and the book's chapter membership.
- The source is marked `synthesized_at` and the run is appended to `log.md`.

## Book

A book is a selection of archived sources laid out as chapters.

1. **Plan** — the LLM groups the selected sources into chapters keyed by topic page, orders the articles within each, and writes nothing new: the topic page is the chapter introduction.
2. **Interior** — articles are reflowed into print HTML (trim size, margins, running heads, page numbers, table of contents, per-article title block with author, site, and date archived) and rendered to `interior.pdf`.
3. **Cover** — sized from the interior page count using the printer's spine calculation; typographic by default, optionally with a generated image. Rendered to `cover.pdf`.
4. **Order** — price quote, confirmation, print job via Lulu's API, status until shipped. Both PDFs stay downloadable for any other printer.

Reprinting articles in a single personal copy is fine; the book is never sold or shared.

## Later

- **Lint**: periodic pass that fixes mechanical drift (missing backlinks, stale index) and surfaces contradictions between sources.
- **Digest email**: what was synthesized, what's queued, what's unexplored.
- **Suggestions**: web search around weak or growing topics; suggested reads are emailed and can be saved straight into the Matter queue via `POST /items`, where they enter the normal flow.

## Scope

**v1**: Matter sync, source pages, graph with states and similarity edges, synthesis of archived items, topic pages, book builder through printed copy.

**Later**: lint, digest, suggestions, per-page public visibility.

## Open questions

- Trim size and binding for the book (default: 6×9, hardcover, black-and-white interior).
- Cover: typographic only, or a generated image.
- Book unit: everything since the last book, or a hand-picked set of topics.
