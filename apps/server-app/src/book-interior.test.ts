import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  addPageNumbers,
  destinationPageNumbers,
  imageSpansColumns,
  isDecorativeImage,
  normalizeInteriorPdf,
  renderInteriorHtml,
} from "./book-interior";
import type { BookManifest } from "./books";

const manifest: BookManifest = {
  id: "book-1",
  title: "Ways of Becoming",
  created_at: "2026-08-25T00:00:00.000Z",
  previous_source_cutoff: null,
  source_cutoff: "2026-08-25T00:00:00.000Z",
  chapters: [{ title: "Ideas < Practice", sources: ["itm_a"] }],
};

describe("renderInteriorHtml", () => {
  it("renders the book structure, article markdown, and print dimensions", () => {
    const html = renderInteriorHtml({
      manifest,
      artwork: {
        chapters: [{ chapterIndex: 0, title: "Ideas < Practice", src: "data:image/png;base64,Y2hhcHRlcg==" }],
      },
      sources: [
        {
          meta: {
            matter_id: "itm_a",
            title: "An <Article>",
            url: "https://example.com/article",
            site: "Example",
            author: "A. Writer",
            content_type: "article",
            state: "archived",
            progress: 1,
            favorite: false,
            archived_at: "2026-08-24T00:00:00.000Z",
            matter_updated_at: "2026-08-24T00:00:00.000Z",
          },
          body: "# A heading\n\nBody text.\n\n![Diagram](https://example.com/diagram.png)\n\n<script>alert('no')</script>",
        },
      ],
    });

    expect(html).toContain("size: 8.75in 11.25in");
    expect(html).toContain("@page content");
    expect(html).toContain("@page artwork");
    expect(html).toContain("width: 100vw");
    expect(html).toContain("height: 100vh");
    expect(html).toContain('class="title-page"');
    expect(html).toContain("background: #f7f2e5");
    expect(html).toContain('data-book-artwork="true"');
    expect(html).toContain("Ways of Becoming");
    expect(html).toContain('<section class="chapter-content">');
    expect(html).toContain("column-count: 2");
    expect(html).toContain("column-fill: balance");
    expect(html).toContain('<a href="#article-itm_a">');
    expect(html).toContain('<span class="toc-page" data-target="article-itm_a">000</span>');
    expect(html).toContain('<article class="article" id="article-itm_a">');
    expect(html).toContain(".article + .article { break-before: column; }");
    expect(html).not.toContain("column-rule");
    expect(html).toContain("column-span: all");
    expect(html).toContain("Ways of Becoming");
    expect(html).toContain("Ideas &lt; Practice");
    expect(html).toContain("An &lt;Article&gt;");
    expect(html).toContain('<img src="https://example.com/diagram.png" alt="Diagram">');
    expect(html).toContain("&lt;script&gt;alert(&#39;no&#39;)&lt;/script&gt;");
  });

  it("fails when a manifest source is unavailable", () => {
    expect(() =>
      renderInteriorHtml({
        manifest,
        artwork: {
          chapters: [{ chapterIndex: 0, title: "Ideas < Practice", src: "data:image/png;base64,Y2hhcHRlcg==" }],
        },
        sources: [],
      }),
    ).toThrow("book source not found: itm_a");
  });

  it("fails when grouped-chapter artwork is unavailable", () => {
    expect(() =>
      renderInteriorHtml({
        manifest,
        artwork: { chapters: [] },
        sources: [
          {
            meta: {
              matter_id: "itm_a",
              title: "An Article",
              url: "https://example.com/article",
              content_type: "article",
              state: "archived",
              progress: 1,
              favorite: false,
              archived_at: "2026-08-24T00:00:00.000Z",
              matter_updated_at: "2026-08-24T00:00:00.000Z",
            },
            body: "Body text.",
          },
        ],
      }),
    ).toThrow("book artwork not found for chapter 1: Ideas < Practice");
  });
});

describe("isDecorativeImage", () => {
  it("identifies explicit logos", () => {
    expect(isDecorativeImage({ src: "https://example.com/image.png", alt: "Mozilla logo" })).toBe(true);
  });

  it("identifies direct and GitHub-proxied Shields badges", () => {
    const source = "https://img.shields.io/badge/build-passing";
    const encodedSource = Array.from(new TextEncoder().encode(source), (byte) => byte.toString(16).padStart(2, "0")).join("");

    expect(isDecorativeImage({ src: source, alt: "build passing" })).toBe(true);
    expect(
      isDecorativeImage({
        src: `https://camo.githubusercontent.com/hash/${encodedSource}`,
        alt: "build passing",
      }),
    ).toBe(true);
  });

  it("keeps small content images", () => {
    expect(isDecorativeImage({ src: "https://example.com/equation.png", alt: "chain rule" })).toBe(false);
  });
});

describe("imageSpansColumns", () => {
  it("reserves full width for wide images with enough resolution for US Letter", () => {
    expect(imageSpansColumns({ width: 1_280, height: 780 })).toBe(true);
  });

  it("keeps near-square and low-resolution images in one column", () => {
    expect(imageSpansColumns({ width: 1_080, height: 1_031 })).toBe(false);
    expect(imageSpansColumns({ width: 1_000, height: 600 })).toBe(false);
  });
});

describe("destinationPageNumbers", () => {
  it("maps Chrome named destinations to PDF page numbers", async () => {
    const document = await PDFDocument.create();
    document.addPage([450, 666]);
    const articlePage = document.addPage([450, 666]);
    const destinations = document.context.obj({});
    destinations.set(
      PDFName.of("article-itm_a"),
      document.context.obj([articlePage.ref, PDFName.of("XYZ"), 0, 0, null]),
    );
    document.catalog.set(PDFName.of("Dests"), destinations);

    await expect(destinationPageNumbers(await document.save())).resolves.toEqual({ "article-itm_a": 2 });
  });
});

describe("addPageNumbers", () => {
  it("adds numbers without changing the page count", async () => {
    const document = await PDFDocument.create();
    document.addPage([630, 810]);
    document.addPage([630, 810]);
    const pdf = await document.save();

    const numbered = await addPageNumbers({ pdf, excludedPageNumbers: new Set([1]) });
    const result = await PDFDocument.load(numbered);

    expect(result.getPageCount()).toBe(2);
    expect(numbered.byteLength).toBeGreaterThan(pdf.byteLength);
  });
});

describe("normalizeInteriorPdf", () => {
  it("pads a valid interior to Lulu's minimum and a multiple of four pages", async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index < 31; index++) document.addPage([630, 810]);

    const normalized = await normalizeInteriorPdf(await document.save());
    const result = await PDFDocument.load(normalized.pdf);

    expect(normalized.pageCount).toBe(32);
    expect(result.getPageCount()).toBe(32);
  });

  it("rejects pages that do not include the required bleed", async () => {
    const document = await PDFDocument.create();
    document.addPage([612, 792]);

    await expect(normalizeInteriorPdf(await document.save())).rejects.toThrow("expected 630 × 810");
  });
});
