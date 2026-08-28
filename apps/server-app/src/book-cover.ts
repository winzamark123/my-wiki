import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";

import type { BookCoverDimensions } from "./books";

const TRIM_WIDTH_INCHES = 8.5;
const TRIM_HEIGHT_INCHES = 11;
const BLEED_INCHES = 0.125;
const COVER_SAFETY_INCHES = 0.5;
const SPINE_TEXT_SAFETY_INCHES = 0.125;
const PAGE_SIZE_TOLERANCE_POINTS = 0.5;
const FONT_CSS =
  "https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,600&display=swap";

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
  );
}

export function coverLayout({
  dimensions,
  pageCount,
}: {
  dimensions: BookCoverDimensions;
  pageCount: number;
}) {
  if (dimensions.unit !== "inch") throw new Error(`cover dimensions must use inches, got ${dimensions.unit}`);

  const expectedHeight = TRIM_HEIGHT_INCHES + BLEED_INCHES * 2;
  if (Math.abs(dimensions.height - expectedHeight) > 0.001) {
    throw new Error(`cover height is ${dimensions.height} inches; expected ${expectedHeight}`);
  }

  const spineWidth = dimensions.width - TRIM_WIDTH_INCHES * 2 - BLEED_INCHES * 2;
  if (spineWidth <= 0) throw new Error(`cover width ${dimensions.width} does not leave room for a spine`);

  const spineLeft = BLEED_INCHES + TRIM_WIDTH_INCHES;
  const frontLeft = spineLeft + spineWidth;
  const availableSpineTextPoints = (spineWidth - SPINE_TEXT_SAFETY_INCHES * 2) * 72;
  const spineFontSizePoints = Math.min(10, Math.floor(availableSpineTextPoints * 10) / 10);

  return {
    width: dimensions.width,
    height: dimensions.height,
    spineWidth,
    spineLeft,
    frontLeft,
    spineFontSizePoints,
    showSpineTitle: pageCount > 80 && spineFontSizePoints >= 6,
  };
}

export function renderCoverHtml({
  title,
  artwork,
  dimensions,
  pageCount,
}: {
  title: string;
  artwork: string;
  dimensions: BookCoverDimensions;
  pageCount: number;
}) {
  const layout = coverLayout({ dimensions, pageCount });
  const spineTitle = layout.showSpineTitle
    ? `<div class="spine-title">${escapeHtml(title)}</div>`
    : "";

  return `<!doctype html>
<html lang="en" style="--cover-tone: #dce4dc">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} — Cover</title>
  <link rel="stylesheet" href="${FONT_CSS}">
  <style>
    @page { size: ${layout.width}in ${layout.height}in; margin: 0; }
    *, *::before, *::after { box-sizing: border-box; }
    html { color-scheme: only light; }
    body {
      width: ${layout.width}in;
      height: ${layout.height}in;
      margin: 0;
      overflow: hidden;
      color: #17302f;
      background: var(--cover-tone);
      font-family: "Newsreader", Georgia, serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cover {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--cover-tone);
    }
    .front {
      position: absolute;
      inset: 0 0 0 ${layout.frontLeft}in;
      overflow: hidden;
    }
    .front-artwork {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .front-title {
      position: absolute;
      left: ${COVER_SAFETY_INCHES}in;
      bottom: ${BLEED_INCHES + COVER_SAFETY_INCHES}in;
      max-width: ${TRIM_WIDTH_INCHES - COVER_SAFETY_INCHES * 2}in;
      padding: 0.28in 0.34in;
      background: #f7f2e5;
    }
    .front-title h1 {
      max-width: 6.5in;
      margin: 0;
      font-size: 34pt;
      font-weight: 400;
      line-height: 1.02;
    }
    .spine {
      position: absolute;
      top: 0;
      bottom: 0;
      left: ${layout.spineLeft}in;
      width: ${layout.spineWidth}in;
      background: var(--cover-tone);
    }
    .spine-title {
      position: absolute;
      top: ${BLEED_INCHES + COVER_SAFETY_INCHES}in;
      bottom: ${BLEED_INCHES + COVER_SAFETY_INCHES}in;
      left: ${SPINE_TEXT_SAFETY_INCHES}in;
      width: ${layout.spineWidth - SPINE_TEXT_SAFETY_INCHES * 2}in;
      overflow: hidden;
      font-family: Arial, sans-serif;
      font-size: ${layout.spineFontSizePoints}pt;
      line-height: 1;
      letter-spacing: 0.08em;
      text-align: center;
      text-transform: uppercase;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
    }
  </style>
</head>
<body>
  <main class="cover">
    <section class="spine">${spineTitle}</section>
    <section class="front">
      <img id="cover-artwork" class="front-artwork" src="${escapeHtml(artwork)}" alt="">
      <div class="front-title"><h1>${escapeHtml(title)}</h1></div>
    </section>
  </main>
</body>
</html>`;
}

export async function normalizeCoverPdf({
  pdf,
  dimensions,
}: {
  pdf: Uint8Array;
  dimensions: BookCoverDimensions;
}) {
  const document = await PDFDocument.load(pdf);
  if (document.getPageCount() !== 1) throw new Error(`cover PDF has ${document.getPageCount()} pages; expected 1`);

  const page = document.getPage(0);
  const { width, height } = page.getSize();
  const expectedWidth = dimensions.width * 72;
  const expectedHeight = dimensions.height * 72;
  if (
    Math.abs(width - expectedWidth) > PAGE_SIZE_TOLERANCE_POINTS ||
    Math.abs(height - expectedHeight) > PAGE_SIZE_TOLERANCE_POINTS
  ) {
    throw new Error(`cover page is ${width} × ${height} points; expected ${expectedWidth} × ${expectedHeight}`);
  }

  page.scaleContent(expectedWidth / width, expectedHeight / height);
  page.setSize(expectedWidth, expectedHeight);
  return document.save();
}

export async function renderCoverPdf({
  browserBinding,
  html,
  dimensions,
}: {
  browserBinding: BrowserWorker;
  html: string;
  dimensions: BookCoverDimensions;
}) {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    await page.setContent(html, { waitUntil: "networkidle0" });
    const coverTone = z.string().regex(/^rgb\(\d+, \d+, \d+\)$/).parse(
      await page.evaluate(`(async () => {
        await document.fonts.ready;
        const image = document.querySelector("#cover-artwork");
        if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth === 0) {
          throw new Error("book cover artwork is unavailable");
        }
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("cover color sampler is unavailable");
        context.drawImage(image, 0, 0, 1, 1);
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
        const paper = [247, 242, 229];
        const mixed = [red, green, blue].map((channel, index) => Math.round(channel * 0.35 + paper[index] * 0.65));
        const tone = "rgb(" + mixed.join(", ") + ")";
        document.documentElement.style.setProperty("--cover-tone", tone);
        return tone;
      })()`),
    );
    const renderedHtml = await page.content();
    const renderedPdf = await page.pdf({
      width: `${dimensions.width}in`,
      height: `${dimensions.height}in`,
      margin: { top: "0in", right: "0in", bottom: "0in", left: "0in" },
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      printBackground: true,
      tagged: true,
      waitForFonts: true,
    });
    const pdf = await normalizeCoverPdf({ pdf: renderedPdf, dimensions });
    return { pdf, html: renderedHtml, coverTone };
  } finally {
    await browser.close();
  }
}
