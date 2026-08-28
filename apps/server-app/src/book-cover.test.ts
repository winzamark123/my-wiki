import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { coverLayout, normalizeCoverPdf, renderCoverHtml } from "./book-cover";
import type { BookCoverDimensions } from "./books";

const dimensions: BookCoverDimensions = { width: 17.607, height: 11.25, unit: "inch" };

describe("coverLayout", () => {
  it("derives the spine and front positions from Lulu dimensions", () => {
    expect(coverLayout({ dimensions, pageCount: 132 })).toEqual({
      width: 17.607,
      height: 11.25,
      spineWidth: expect.closeTo(0.357, 6),
      spineLeft: 8.625,
      frontLeft: expect.closeTo(8.982, 6),
      spineFontSizePoints: 7.7,
      showSpineTitle: true,
    });
  });

  it("omits spine text when the book is too short", () => {
    expect(coverLayout({ dimensions, pageCount: 80 }).showSpineTitle).toBe(false);
  });

  it("rejects dimensions that do not describe a US Letter cover", () => {
    expect(() =>
      coverLayout({ dimensions: { width: 17.607, height: 11, unit: "inch" }, pageCount: 132 }),
    ).toThrow("expected 11.25");
  });
});

describe("renderCoverHtml", () => {
  it("renders a safe full-spread cover with front artwork and a quiet back", () => {
    const html = renderCoverHtml({
      title: "The River & Code",
      artwork: "data:image/svg+xml;base64,Y292ZXI=",
      dimensions,
      pageCount: 132,
    });

    expect(html).toContain("size: 17.607in 11.25in");
    expect(html).toContain('class="spine-title"');
    expect(html).toContain("The River &amp; Code");
    expect(html).toContain('id="cover-artwork"');
    expect(html).toContain("inset: 0 0 0 8.982");
    expect(html).toContain("bottom: 0.625in");
    expect(html).not.toContain("back-title");
  });
});

describe("normalizeCoverPdf", () => {
  it("sets the page to the exact dimensions returned by Lulu", async () => {
    const document = await PDFDocument.create();
    document.addPage([dimensions.width * 72 + 0.2, dimensions.height * 72]);

    const normalized = await normalizeCoverPdf({ pdf: await document.save(), dimensions });
    const page = (await PDFDocument.load(normalized)).getPage(0);

    expect(page.getSize()).toEqual({ width: dimensions.width * 72, height: dimensions.height * 72 });
  });

  it("rejects an incorrect page count or size", async () => {
    const twoPages = await PDFDocument.create();
    twoPages.addPage([dimensions.width * 72, dimensions.height * 72]);
    twoPages.addPage([dimensions.width * 72, dimensions.height * 72]);
    await expect(normalizeCoverPdf({ pdf: await twoPages.save(), dimensions })).rejects.toThrow("2 pages");

    const wrongSize = await PDFDocument.create();
    wrongSize.addPage([612, 792]);
    await expect(normalizeCoverPdf({ pdf: await wrongSize.save(), dimensions })).rejects.toThrow("cover page is");
  });
});
