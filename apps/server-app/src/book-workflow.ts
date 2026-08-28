import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import {
  ARTWORK_MODEL,
  bookArtworkSchema,
  createBookArtworkPrompt,
  createChapterArtworkPrompt,
  createFalArtworkGenerator,
  type BookArtworkAsset,
} from "./artwork";
import { renderCoverHtml, renderCoverPdf } from "./book-cover";
import { renderInteriorHtml, renderInteriorPdf } from "./book-interior";
import {
  getBookChapterArtworkDataUrls,
  getBookCoverArtworkDataUrl,
  getBookIndex,
  getBookStatus,
  getCoverHtml,
  getInteriorHtml,
  writeArtworkImage,
  writeBookArtwork,
  writeBookManifest,
  writeCoverFailure,
  writeCoverHtml,
  writeCoverPdf,
  writeInteriorHtml,
  writeInteriorPdf,
} from "./book-store";
import {
  bookCoverDimensionsSchema,
  bookManifestSchema,
  createChapterPlan,
  latestSourceCutoff,
  selectExportSources,
  type BookCoverDimensions,
} from "./books";
import { getEmbeddingStore } from "./embeddings";
import { createLuluClient } from "./lulu";
import { getSource } from "./source-store";
import { getIndex } from "./wiki-index";

export interface BookWorkflowParams {
  // sources archived up to this instant are in the book; captured by the route so retries stay stable
  source_cutoff: string;
}

// external calls (FAL, Browser Rendering) fail transiently; workflow steps that make them retry with backoff
const EXTERNAL_RETRIES = { limit: 3, delay: "10 seconds", backoff: "exponential" } as const;

export class BookWorkflow extends WorkflowEntrypoint<Env, BookWorkflowParams> {
  async run(event: WorkflowEvent<BookWorkflowParams>, step: WorkflowStep) {
    const { source_cutoff } = event.payload;
    const selection = await step.do("select sources", async () => {
      const [index, bookIndex] = await Promise.all([getIndex(this.env.WIKI), getBookIndex(this.env.WIKI)]);
      const previousSourceCutoff = latestSourceCutoff(bookIndex);
      const sources = selectExportSources({
        sources: index.sources,
        previousSourceCutoff,
        sourceCutoff: source_cutoff,
      });
      const ids = new Set(sources.map((source) => source.matter_id));
      return {
        sources,
        links: index.links.filter(({ a, b }) => ids.has(a) && ids.has(b)),
        previousSourceCutoff,
      };
    });

    if (selection.sources.length === 0) {
      return { id: event.instanceId, sources: 0, chapters: 0 };
    }

    const plan = await step.do("plan chapters", async () => {
      const embeddings = await getEmbeddingStore(this.env.WIKI);
      return createChapterPlan({
        ai: this.env.AI,
        sources: selection.sources,
        links: selection.links,
        embeddings,
      });
    });

    const manifest = bookManifestSchema.parse({
      id: event.instanceId,
      title: plan.title,
      created_at: event.timestamp.toISOString(),
      previous_source_cutoff: selection.previousSourceCutoff,
      source_cutoff,
      chapters: plan.chapters,
    });
    await step.do("write manifest", () => writeBookManifest({ bucket: this.env.WIKI, manifest }));

    const artworkGenerator = createFalArtworkGenerator({
      apiKey: this.env.FAL_KEY,
      styleId: this.env.FAL_STYLE_ID,
    });
    const createArtwork = async ({ name, prompt }: { name: string; prompt: string }) => {
      const requestId = await step.do(
        `submit ${name} artwork`,
        { retries: EXTERNAL_RETRIES, timeout: "1 minute" },
        () => artworkGenerator.submit({ prompt }),
      );
      return step.do(
        `store ${name} artwork`,
        { retries: EXTERNAL_RETRIES, timeout: "30 minutes" },
        async () => {
          const generated = await artworkGenerator.result({ requestId });
          const key = await writeArtworkImage({
            bucket: this.env.WIKI,
            bookId: manifest.id,
            name,
            bytes: generated.bytes,
            contentType: generated.contentType,
          });
          return {
            key,
            prompt,
            request_id: requestId,
            content_type: generated.contentType,
            width: generated.width,
            height: generated.height,
          } satisfies BookArtworkAsset;
        },
      );
    };

    const cover = await createArtwork({
      name: "cover",
      prompt: createBookArtworkPrompt({ title: manifest.title, chapters: manifest.chapters }),
    });
    const sourceById = new Map(selection.sources.map((source) => [source.matter_id, source]));
    const chapterArtwork = [];
    for (const [chapterIndex, chapter] of manifest.chapters.entries()) {
      const sources = chapter.sources.map((id) => {
        const source = sourceById.get(id);
        if (!source) throw new Error(`book source not found for artwork: ${id}`);
        return source;
      });
      const asset = await createArtwork({
        name: `chapter-${String(chapterIndex + 1).padStart(2, "0")}`,
        prompt: createChapterArtworkPrompt({
          bookTitle: manifest.title,
          chapterTitle: chapter.title,
          sources,
        }),
      });
      chapterArtwork.push({ ...asset, chapter_index: chapterIndex, title: chapter.title });
    }
    const artwork = bookArtworkSchema.parse({
      provider: "fal",
      model: ARTWORK_MODEL,
      style_id: this.env.FAL_STYLE_ID,
      cover,
      chapters: chapterArtwork,
    });
    await step.do("write artwork manifest", () =>
      writeBookArtwork({ bucket: this.env.WIKI, bookId: manifest.id, artwork }),
    );

    await step.do("render interior HTML", async () => {
      const sourceIds = manifest.chapters.flatMap((chapter) => chapter.sources);
      const sources = await Promise.all(
        sourceIds.map(async (id) => {
          const source = await getSource(this.env.WIKI, id);
          if (!source) throw new Error(`book source not found: ${id}`);
          return source;
        }),
      );
      const artworkDataUrls = await getBookChapterArtworkDataUrls({ bucket: this.env.WIKI, artwork });
      const html = renderInteriorHtml({ manifest, sources, artwork: artworkDataUrls });
      await writeInteriorHtml({ bucket: this.env.WIKI, bookId: manifest.id, html });
      return { bytes: new TextEncoder().encode(html).byteLength };
    });

    const interior = await step.do(
      "render interior PDF",
      { retries: EXTERNAL_RETRIES, timeout: "10 minutes" },
      async () => {
        const html = await getInteriorHtml({ bucket: this.env.WIKI, bookId: manifest.id });
        const { pdf, pageCount, unavailableImages, html: paginatedHtml } = await renderInteriorPdf({
          browserBinding: this.env.BROWSER,
          html,
        });
        await writeInteriorHtml({ bucket: this.env.WIKI, bookId: manifest.id, html: paginatedHtml });
        await writeInteriorPdf({
          bucket: this.env.WIKI,
          bookId: manifest.id,
          pdf,
          pageCount,
          unavailableImages,
          now: new Date().toISOString(),
        });
        return { bytes: pdf.byteLength, pageCount, unavailableImages: unavailableImages.length };
      },
    );

    const interiorStatus = await step.do("read interior status", async () => {
      const status = await getBookStatus({ bucket: this.env.WIKI, bookId: manifest.id });
      if (status.state !== "interior_ready") throw new Error(`book ${manifest.id} is not ready for its cover`);
      return status;
    });
    const lulu = createLuluClient({
      baseUrl: this.env.LULU_BASE_URL,
      clientKey: this.env.LULU_CLIENT_KEY,
      clientSecret: this.env.LULU_CLIENT_SECRET,
    });
    let coverDimensions: BookCoverDimensions | undefined;
    try {
      const dimensions = await step.do(
        "calculate cover dimensions",
        { retries: EXTERNAL_RETRIES, timeout: "1 minute" },
        async () =>
          bookCoverDimensionsSchema.parse(
            await lulu.calculateCoverDimensions({
              podPackageId: this.env.BOOK_POD_PACKAGE_ID,
              interiorPageCount: interiorStatus.page_count,
              unit: "inch",
            }),
          ),
      );
      coverDimensions = dimensions;

      await step.do("render cover HTML", async () => {
        const coverArtwork = await getBookCoverArtworkDataUrl({ bucket: this.env.WIKI, artwork });
        const html = renderCoverHtml({
          title: manifest.title,
          artwork: coverArtwork,
          dimensions,
          pageCount: interiorStatus.page_count,
        });
        await writeCoverHtml({ bucket: this.env.WIKI, bookId: manifest.id, html });
        return { bytes: new TextEncoder().encode(html).byteLength };
      });

      const outerCover = await step.do(
        "render cover PDF",
        { retries: EXTERNAL_RETRIES, timeout: "10 minutes" },
        async () => {
          const html = await getCoverHtml({ bucket: this.env.WIKI, bookId: manifest.id });
          const rendered = await renderCoverPdf({
            browserBinding: this.env.BROWSER,
            html,
            dimensions,
          });
          await writeCoverPdf({
            bucket: this.env.WIKI,
            bookId: manifest.id,
            html: rendered.html,
            pdf: rendered.pdf,
            interiorStatus,
            dimensions,
            now: new Date().toISOString(),
          });
          return { bytes: rendered.pdf.byteLength, coverTone: rendered.coverTone };
        },
      );

      return {
        id: manifest.id,
        sources: selection.sources.length,
        chapters: manifest.chapters.length,
        pageCount: interior.pageCount,
        artwork: {
          count: artwork.chapters.length + 1,
          width: artwork.cover.width,
          height: artwork.cover.height,
        },
        cover: { ...dimensions, tone: outerCover.coverTone },
      };
    } catch (error) {
      await step.do("record cover failure", () =>
        writeCoverFailure({
          bucket: this.env.WIKI,
          bookId: manifest.id,
          interiorStatus,
          dimensions: coverDimensions,
          error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
          now: new Date().toISOString(),
        }),
      );
      throw error;
    }
  }
}
