# Reading Wiki — Design Spec

A graph of everything I read in [Matter](https://getmatter.com), one page per item, printable as a physical book. Nothing is written for the wiki; it is the reading record itself. The only authored signal is what I saved, what I finished, and what I starred.

Private. One user today; later each user brings their own Matter token (see Later). Matter is the only input. There is no input box, no editing, and no generated prose.

## Core principles

- **Matter is the only input.** Nothing enters the wiki except through my Matter library. Saving to the queue adds a node. There is no other way in.
- **Archive is the gate for the book.** Only finished reading is printed. Queued and in-progress items are visible in the graph as the frontier.
- **Zero writing.** Every article comes from something I chose to read. The wiki adds structure, never prose; the only generated text is a few-word link label or chapter title.
- **Reading the wiki needs no model.** Embeddings, reranking, and labeling run at sync time; nothing is computed when a page is opened.
- **The book is the output.** The wiki exists so that, at some point, it can be laid out and printed. Everything in the data model serves that.

## States

Matter has an inbox (a feed of writers and newsletters I follow), a queue (things I saved myself), and an archive. The wiki ignores the inbox; swiping an item to the queue in Matter is the act that adds it to the wiki.

| Wiki state | Matter condition | Shown as |
| --- | --- | --- |
| `queued` | in queue, `reading_progress = 0` | hollow dotted circle |
| `reading` | in queue, `reading_progress > 0` | ring with an arc covering the progress |
| `archived` | in archive | solid circle; progress is ignored |

Archive means finished regardless of progress; many items are archived without scrolling to the end.

## Architecture (two layers)

1. **Sources** — one page per Matter item: metadata, state, progress, and the article body as Matter delivers it. Immutable apart from state changes. Private (copies of other people's writing).
2. **Index** — every source's metadata plus labeled links between related articles, rebuilt after each sync. One file serves the graph, the list, and the book planner. Shapes in ARCHITECTURE.md.

A server owns both layers and every job (sync, links, book). The web app is one client of that server, reading over an API; other clients, such as a reading page on my portfolio site, read the same public index. Nothing but the server touches Matter or the stored sources.

## Surfaces

### Graph (home)
Force-directed graph of every source.

- **Sources** are circles, drawn by state as above. Radius scales with word count.
- **Related edges** (dotted) connect two articles a model judged related. Hovering an edge shows why in a few words; hovering a node highlights its edges.
- Filters: by state, by favorite, by site, by word count. Each is a predicate on the index.
- A legend under the graph explains the vocabulary.

A list view shows the same sources grouped by state.

### Source page
The Matter item rendered readably: title, author, site, state, progress, word count, archived date, a link to the original, the article body, and a Related list at the end with the reason for each link. Never public.

### Book builder
Export every source archived since the previous completed export, preview the chapter plan, see a price quote, and order. Details under Book.

## Ingestion

A daily job pulls every queue and archive item from the Matter API using `updated_since`, so each run fetches only what changed.

- New items get a source page with metadata and state. The article body (`?include=markdown`) is fetched once.
- State and progress updates rewrite the source frontmatter; the graph reflects them on the next render.
- Each item is embedded in full (title + body, images stripped). The nearest articles are reranked, then a model confirms which are related and writes a short label for each. Link labels and later book chapter titles are the only generated text; neither summarizes or adds to the articles.
- Highlights and annotations are not fetched. Tags are not used.

Matter hosts article images on its own CDN; the wiki and the book load images by URL and store no copies.

## Book

A book is one export batch of archived sources laid out as chapters. The first export includes all archived sources. Each later export includes sources archived after the previous completed export and at or before a cutoff captured when the new export starts.

The print format is a 6 × 9 inch US Trade paperback with Perfect Bound binding, a Premium Color interior on 80# White Coated paper, and a matte cover. The Lulu pod package ID is `0600X0900.FC.PRE.PB.080CW444.MXX`.

1. **Plan** — a model uses the links, embeddings, and source titles to group the selected sources into chapters, order them, and write a short title for each chapter. No introduction or other prose is written.
2. **Interior** — articles and their native blog images are reflowed into print HTML (trim size, margins, running heads, page numbers, table of contents, per-article title block with author, site, and date archived) and rendered in color to `interior.pdf`.
3. **Cover** — a generated image and typography are laid out using the interior page count and the printer's spine calculation, then rendered to `cover.pdf` for a matte finish.
4. **Order** — price quote, confirmation, print job via Lulu's API, status until shipped. Both PDFs stay downloadable for any other printer.

An export is complete only after both PDFs are generated successfully. Its cutoff then becomes the starting point for the next export; previews and failed exports do not advance it.

Reprinting articles in a single personal copy is fine; the book is never sold or shared.

## Later

- **Digest email**: what was archived, what's in progress, what's queued.
- **Suggestions**: web search around recent reading; suggested reads are emailed and can be saved straight into the Matter queue via `POST /items`, where they enter the normal flow.
- **Multi-user**: anyone allowed in can add their own Matter token; the server syncs each library separately and keeps each user's sources private to them. The graph stays per user; there is no shared graph.
- **External clients**: a "my readings" page on my portfolio site shows the public graph from the server API. It needs no auth and no copy of the data.

## Scope

**v1**: Matter sync, source pages, graph with states and labeled links, book builder through printed copy.

**Later**: digest, suggestions, multi-user, external clients.
