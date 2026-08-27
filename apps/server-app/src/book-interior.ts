import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { Marked } from "marked";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts, rgb } from "pdf-lib";
import { z } from "zod";

import type { BookArtworkDataUrls } from "./artwork";
import type { BookManifest } from "./books";
import type { SourceMeta } from "./sources";

const MIN_PAGES = 32;
const MAX_PAGES = 800;
const PAGE_WIDTH_INCHES = 8.75;
const PAGE_HEIGHT_INCHES = 11.25;
const PAGE_MARGIN_INCHES = 0.75;
const PAGE_WIDTH_POINTS = PAGE_WIDTH_INCHES * 72;
const PAGE_HEIGHT_POINTS = PAGE_HEIGHT_INCHES * 72;
const PAGE_SIZE_TOLERANCE = 0.5;
const FULL_WIDTH_IMAGE_MIN_PPI = 150;
const FULL_WIDTH_IMAGE_MIN_ASPECT_RATIO = 1.25;
const FULL_WIDTH_IMAGE_MIN_WIDTH = Math.ceil(
  (PAGE_WIDTH_INCHES - PAGE_MARGIN_INCHES * 2) * FULL_WIDTH_IMAGE_MIN_PPI,
);
const FONT_CSS =
  "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400;1,6..72,600&display=swap";

const markdown = new Marked({
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
  },
});

type BookSource = { meta: SourceMeta; body: string };

const renderedImageSchema = z.object({
  src: z.string(),
  alt: z.string(),
  naturalWidth: z.number().int().nonnegative(),
  naturalHeight: z.number().int().nonnegative(),
  available: z.boolean(),
  artwork: z.boolean(),
});

function isShieldsBadge(src: string) {
  try {
    const url = new URL(src);
    if (url.hostname === "img.shields.io") return true;
    if (url.hostname !== "camo.githubusercontent.com") return false;

    const encodedSource = url.pathname.split("/").at(-1);
    if (!encodedSource || encodedSource.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encodedSource)) return false;
    const pairs = encodedSource.match(/.{2}/g);
    if (!pairs) return false;
    const decodedSource = new TextDecoder().decode(Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16)));
    return new URL(decodedSource).hostname === "img.shields.io";
  } catch {
    return false;
  }
}

export function isDecorativeImage({ src, alt }: { src: string; alt: string }) {
  return /\blogo\b/i.test(alt) || isShieldsBadge(src);
}

export function imageSpansColumns({ width, height }: { width: number; height: number }) {
  return width >= FULL_WIDTH_IMAGE_MIN_WIDTH && width / height >= FULL_WIDTH_IMAGE_MIN_ASPECT_RATIO;
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
  );
}

function articlesLabel(count: number) {
  return `${count} ${count === 1 ? "article" : "articles"}`;
}

function articleTarget(id: string) {
  return `article-${id}`;
}

function chapterTarget(index: number) {
  return `chapter-${index + 1}`;
}

function renderSource(source: BookSource) {
  const facts = [source.meta.author, source.meta.site, source.meta.archived_at?.slice(0, 10)]
    .filter((value): value is string => Boolean(value))
    .map(escapeHtml)
    .join(" · ");
  const body = markdown.parse(source.body, { async: false });
  return `<article class="article" id="${escapeHtml(articleTarget(source.meta.matter_id))}">
  <header class="article-header">
    <p class="article-label">Article</p>
    <h2>${escapeHtml(source.meta.title)}</h2>
    ${facts ? `<p class="article-facts">${facts}</p>` : ""}
    <p class="article-url">${escapeHtml(source.meta.url)}</p>
  </header>
  <div class="prose">${body}</div>
</article>`;
}

export function renderInteriorHtml({
  manifest,
  sources,
  artwork,
}: {
  manifest: BookManifest;
  sources: BookSource[];
  artwork: BookArtworkDataUrls;
}) {
  const sourceById = new Map(sources.map((source) => [source.meta.matter_id, source]));
  const chapterArtworkByIndex = new Map(artwork.chapters.map((chapter) => [chapter.chapterIndex, chapter]));
  const sourceForId = (id: string) => {
    const source = sourceById.get(id);
    if (!source) throw new Error(`book source not found: ${id}`);
    return source;
  };
  const articleCount = manifest.chapters.reduce((count, chapter) => count + chapter.sources.length, 0);
  const contents = manifest.chapters
    .map((chapter, index) => {
      const chapterId = chapterTarget(index);
      const articles = chapter.sources
        .map((id) => {
          const source = sourceForId(id);
          const target = articleTarget(id);
          return `<li class="toc-article">
  <a href="#${escapeHtml(target)}">
    <span>${escapeHtml(source.meta.title)}</span>
    <span class="toc-page" data-target="${escapeHtml(target)}">000</span>
  </a>
</li>`;
        })
        .join("\n");
      return `<li class="toc-chapter">
  <a class="toc-chapter-heading" href="#${chapterId}">
    <span class="toc-number">${String(index + 1).padStart(2, "0")}</span>
    <span>${escapeHtml(chapter.title)}</span>
    <span class="toc-page" data-target="${chapterId}">000</span>
  </a>
  <ol class="toc-articles">${articles}</ol>
</li>`;
    })
    .join("\n");
  const chapters = manifest.chapters
    .map((chapter, index) => {
      const chapterArtwork = chapterArtworkByIndex.get(index);
      if (!chapterArtwork || chapterArtwork.title !== chapter.title) {
        throw new Error(`book artwork not found for chapter ${index + 1}: ${chapter.title}`);
      }
      const articles = chapter.sources.map((id) => renderSource(sourceForId(id))).join("\n");
      return `<section class="chapter-opener artwork-page" id="${chapterTarget(index)}">
  <img class="artwork-background" data-book-artwork="true" src="${escapeHtml(chapterArtwork.src)}" alt="Artwork for ${escapeHtml(chapter.title)}">
  <div class="artwork-copy chapter-opener-copy">
    <p>Chapter ${index + 1} · ${articlesLabel(chapter.sources.length)}</p>
    <h1>${escapeHtml(chapter.title)}</h1>
  </div>
</section>
<section class="chapter-content">${articles}</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(manifest.title)}</title>
  <link rel="stylesheet" href="${FONT_CSS}">
  <style>
    @page {
      size: ${PAGE_WIDTH_INCHES}in ${PAGE_HEIGHT_INCHES}in;
      margin: 0;
    }
    @page content {
      size: ${PAGE_WIDTH_INCHES}in ${PAGE_HEIGHT_INCHES}in;
      margin: ${PAGE_MARGIN_INCHES}in;
    }
    @page artwork {
      size: ${PAGE_WIDTH_INCHES}in ${PAGE_HEIGHT_INCHES}in;
      margin: 0;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { color-scheme: only light; }
    body {
      margin: 0;
      color: #171717;
      background: #fff;
      font-family: "Newsreader", Georgia, serif;
      font-size: 10.5pt;
      line-height: 1.48;
      text-rendering: optimizeLegibility;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .artwork-page {
      page: artwork;
      position: relative;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      break-after: page;
    }
    .artwork-background {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .artwork-copy {
      position: absolute;
      z-index: 1;
      right: 0.75in;
      bottom: 0.8in;
      left: 0.75in;
      width: fit-content;
      max-width: 6.25in;
      padding: 0.28in 0.34in;
      color: #17302f;
      background: rgba(247, 242, 229, 0.92);
    }
    .title-page h1 {
      margin: 0.12in 0;
      font-size: 34pt;
      font-weight: 400;
      line-height: 1.02;
    }
    .title-page p, .chapter-opener p, .article-label {
      margin: 0;
      color: #666;
      font-family: Arial, sans-serif;
      font-size: 7.5pt;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .contents { page: content; break-after: page; }
    .contents h1 {
      margin: 0 0 0.3in;
      font-size: 24pt;
      font-weight: 400;
    }
    .toc-chapters, .toc-articles { margin: 0; padding: 0; list-style: none; }
    .toc-chapters {
      column-count: 2;
      column-fill: auto;
      column-gap: 0.36in;
    }
    .toc-chapter {
      break-inside: avoid;
      margin-bottom: 0.18in;
    }
    .toc-chapter-heading, .toc-article a {
      display: grid;
      gap: 0.08in;
      color: inherit;
      text-decoration: none;
    }
    .toc-chapter-heading {
      grid-template-columns: 0.25in minmax(0, 1fr) 0.25in;
      padding: 0.06in 0;
      border-bottom: 0.5pt solid #a8a29e;
      line-height: 1.1;
    }
    .toc-article a {
      grid-template-columns: minmax(0, 1fr) 0.25in;
      margin-left: 0.33in;
      padding: 0.025in 0;
      font-size: 7.5pt;
      line-height: 1.18;
    }
    .toc-number, .toc-page {
      color: #737373;
      font-family: Arial, sans-serif;
      font-size: 7.5pt;
      font-variant-numeric: tabular-nums;
    }
    .toc-page { text-align: right; }
    .chapter-opener { break-before: right; }
    .chapter-opener h1 {
      margin: 0.12in 0 0;
      font-size: 30pt;
      font-weight: 400;
      line-height: 1.05;
    }
    .chapter-content {
      page: content;
      column-count: 2;
      column-fill: balance;
      column-gap: 0.28in;
      font-size: 9pt;
      line-height: 1.42;
      hyphens: auto;
      text-align: justify;
    }
    .article + .article { break-before: column; }
    .article-header {
      break-after: avoid;
      margin-bottom: 0.24in;
      padding-bottom: 0.14in;
      border-bottom: 0.75pt solid #a8a29e;
    }
    .article-header h2 {
      margin: 0.06in 0 0.1in;
      font-size: 16pt;
      font-weight: 400;
      line-height: 1.08;
    }
    .article-facts, .article-url {
      margin: 0.04in 0 0;
      color: #57534e;
      font-family: Arial, sans-serif;
      font-size: 7.5pt;
      line-height: 1.35;
    }
    .article-url { overflow-wrap: anywhere; }
    .prose p, .prose li { orphans: 3; widows: 3; }
    .prose p { margin: 0 0 0.12in; }
    .prose h1, .prose h2, .prose h3, .prose h4 {
      break-after: avoid;
      margin: 0.28in 0 0.1in;
      font-weight: 600;
      line-height: 1.15;
    }
    .prose h1 { font-size: 15pt; }
    .prose h2 { font-size: 13pt; }
    .prose h3 { font-size: 11pt; }
    .prose h4 { font-size: 9.5pt; }
    .prose a { color: inherit; text-decoration-thickness: 0.5pt; text-underline-offset: 0.08em; }
    .prose blockquote {
      margin: 0.2in 0;
      padding-left: 0.2in;
      border-left: 1.5pt solid #78716c;
      color: #44403c;
      font-style: italic;
    }
    .pagination-pass img { visibility: hidden; }
    .image-block { margin: 0.22in 0; }
    .full-width-image { column-span: all; }
    .prose img {
      display: block;
      width: 100%;
      max-width: 100%;
      max-height: 8.8in;
      margin: 0 auto;
      object-fit: contain;
      break-inside: avoid;
    }
    .prose figure, .prose table, .prose pre { break-inside: avoid; }
    .image-unavailable {
      padding: 0.18in;
      border: 0.5pt solid #d6d3d1;
      color: #78716c;
      font-family: Arial, sans-serif;
      font-size: 8pt;
      text-align: center;
    }
    .prose figcaption {
      margin-top: -0.12in;
      color: #57534e;
      font-family: Arial, sans-serif;
      font-size: 8pt;
      text-align: center;
    }
    .prose pre, .prose code {
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 8pt;
    }
    .prose pre {
      padding: 0.14in;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      background: #f5f5f4;
    }
    .prose table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
    .prose th, .prose td { padding: 0.06in; border: 0.5pt solid #a8a29e; text-align: left; }
    .prose hr { margin: 0.3in 0; border: 0; border-top: 0.5pt solid #a8a29e; }
  </style>
</head>
<body>
  <section class="title-page artwork-page">
    <img class="artwork-background" data-book-artwork="true" src="${escapeHtml(artwork.cover)}" alt="Artwork for ${escapeHtml(manifest.title)}">
    <div class="artwork-copy title-page-copy">
      <p>Personal reading archive</p>
      <h1>${escapeHtml(manifest.title)}</h1>
      <p>${articleCount} articles · ${manifest.created_at.slice(0, 10)}</p>
    </div>
  </section>
  <section class="contents">
    <h1>Contents</h1>
    <ol class="toc-chapters">${contents}</ol>
  </section>
  ${chapters}
</body>
</html>`;
}

export async function destinationPageNumbers(pdf: Uint8Array) {
  const document = await PDFDocument.load(pdf);
  const pages = new Map(document.getPages().map((page, index) => [page.ref.toString(), index + 1]));
  const destinations = document.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  if (!destinations) throw new Error("interior PDF has no named destinations");

  return Object.fromEntries(
    destinations.entries().map(([name, value]) => {
      const destination = destinations.context.lookupMaybe(value, PDFArray);
      const pageReference = destination?.get(0);
      if (!(pageReference instanceof PDFRef)) throw new Error(`invalid PDF destination: ${name.decodeText()}`);
      const pageNumber = pages.get(pageReference.toString());
      if (!pageNumber) throw new Error(`PDF destination page not found: ${name.decodeText()}`);
      return [name.decodeText(), pageNumber] as const;
    }),
  );
}

export async function addPageNumbers({
  pdf,
  excludedPageNumbers,
}: {
  pdf: Uint8Array;
  excludedPageNumbers: Set<number>;
}) {
  const document = await PDFDocument.load(pdf);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontSize = 8;
  for (const [index, page] of document.getPages().entries()) {
    const pageNumber = index + 1;
    if (excludedPageNumbers.has(pageNumber)) continue;
    const text = String(pageNumber);
    page.drawText(text, {
      x: (page.getWidth() - font.widthOfTextAtSize(text, fontSize)) / 2,
      y: 22,
      size: fontSize,
      font,
      color: rgb(0.45, 0.45, 0.45),
    });
  }
  return document.save();
}

export async function normalizeInteriorPdf(pdf: Uint8Array) {
  const document = await PDFDocument.load(pdf);
  const pages = document.getPages();
  for (const [index, page] of pages.entries()) {
    const { width, height } = page.getSize();
    if (Math.abs(width - PAGE_WIDTH_POINTS) > PAGE_SIZE_TOLERANCE || Math.abs(height - PAGE_HEIGHT_POINTS) > PAGE_SIZE_TOLERANCE) {
      throw new Error(`interior page ${index + 1} is ${width} × ${height} points; expected ${PAGE_WIDTH_POINTS} × ${PAGE_HEIGHT_POINTS}`);
    }
  }
  if (pages.length > MAX_PAGES) throw new Error(`interior has ${pages.length} pages; Lulu allows at most ${MAX_PAGES}`);

  const targetPageCount = Math.max(MIN_PAGES, Math.ceil(pages.length / 4) * 4);
  if (targetPageCount === pages.length) return { pdf, pageCount: pages.length };
  for (let pageCount = pages.length; pageCount < targetPageCount; pageCount++) {
    document.addPage([PAGE_WIDTH_POINTS, PAGE_HEIGHT_POINTS]);
  }
  return { pdf: await document.save(), pageCount: targetPageCount };
}

export async function renderInteriorPdf({ browserBinding, html }: { browserBinding: BrowserWorker; html: string }) {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    await page.setContent(html, { waitUntil: "networkidle0" });
    const renderedImages = z.array(renderedImageSchema).parse(
      await page.evaluate(`(async () => {
        await document.fonts.ready;
        return Array.from(document.images).map((image) => ({
          src: image.currentSrc || image.src,
          alt: image.alt,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          available: image.complete && image.naturalWidth > 0,
          artwork: image.dataset.bookArtwork === "true",
        }));
      })()`),
    );
    // one action per image, in document order
    const imageActions = renderedImages.map((image) => {
      const remove = !image.artwork && isDecorativeImage(image);
      return {
        artwork: image.artwork,
        remove,
        unavailable: !remove && !image.available,
        spansColumns:
          !image.artwork && image.available && imageSpansColumns({ width: image.naturalWidth, height: image.naturalHeight }),
      };
    });
    const unavailableImages = renderedImages.flatMap((image, index) => {
      if (!imageActions[index]?.unavailable) return [];
      return [image.artwork ? image.alt : image.src];
    });
    const serializedImageActions = JSON.stringify(imageActions);
    await page.evaluate(`(() => {
      const actions = ${serializedImageActions};
      const images = Array.from(document.images);
      if (images.length !== actions.length) throw new Error("book images changed between passes");
      for (const [index, action] of actions.entries()) {
        const image = images[index];
        const paragraph = image.closest("p");
        // the image may be wrapped (e.g. in a link); act on the paragraph's direct child
        let imageNode = image;
        if (paragraph) {
          while (imageNode.parentElement && imageNode.parentElement !== paragraph) imageNode = imageNode.parentElement;
        }

        if (action.artwork) {
          if (action.unavailable) throw new Error("book artwork unavailable: " + image.alt);
          continue;
        }

        if (action.remove) {
          const caption = paragraph?.nextElementSibling;
          const alt = image.alt.trim();
          imageNode.remove();
          if (paragraph && (!paragraph.textContent?.trim() || paragraph.textContent.trim() === alt)) paragraph.remove();
          if (caption instanceof HTMLParagraphElement && caption.textContent.trim() === alt) caption.remove();
          continue;
        }

        if (paragraph?.parentElement?.classList.contains("prose")) {
          const before = paragraph.cloneNode(false);
          const after = paragraph.cloneNode(false);
          let foundImage = false;
          for (const node of Array.from(paragraph.childNodes)) {
            if (node === imageNode) foundImage = true;
            else (foundImage ? after : before).appendChild(node);
          }
          const figure = document.createElement("figure");
          figure.className = action.spansColumns ? "image-block full-width-image" : "image-block";
          figure.appendChild(imageNode);
          paragraph.replaceWith(
            ...(before.textContent?.trim() || before.children.length ? [before] : []),
            figure,
            ...(after.textContent?.trim() || after.children.length ? [after] : []),
          );
        }

        if (action.unavailable) {
          const replacement = document.createElement("p");
          replacement.className = "image-unavailable";
          replacement.textContent = image.alt ? "Image unavailable: " + image.alt : "Image unavailable from original source";
          image.replaceWith(replacement);
        } else {
          image.style.width = "100%";
          image.style.height = "auto";
        }
      }
    })()`);
    const pdfOptions = {
      width: `${PAGE_WIDTH_INCHES}in`,
      height: `${PAGE_HEIGHT_INCHES}in`,
      margin: { top: "0in", right: "0in", bottom: "0in", left: "0in" },
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      printBackground: true,
      tagged: true,
      outline: true,
      waitForFonts: true,
    };
    await page.evaluate('document.documentElement.classList.add("pagination-pass")');
    const draftPdf = await page.pdf(pdfOptions);
    const pageNumbers = await destinationPageNumbers(draftPdf);
    const serializedPageNumbers = JSON.stringify(pageNumbers);
    await page.evaluate(`(() => {
      const pageNumbers = ${serializedPageNumbers};
      for (const element of document.querySelectorAll(".toc-page[data-target]")) {
        const target = element.getAttribute("data-target");
        const pageNumber = target ? pageNumbers[target] : undefined;
        if (typeof pageNumber !== "number") throw new Error("TOC target page not found: " + target);
        element.textContent = String(pageNumber);
      }
      document.documentElement.classList.remove("pagination-pass");
    })()`);
    const paginatedHtml = await page.content();
    const pdf = await page.pdf(pdfOptions);
    const artworkPageNumbers = new Set([
      1,
      ...Object.entries(pageNumbers).flatMap(([target, pageNumber]) =>
        target.startsWith("chapter-") ? [pageNumber] : [],
      ),
    ]);
    const numberedPdf = await addPageNumbers({ pdf, excludedPageNumbers: artworkPageNumbers });
    const normalized = await normalizeInteriorPdf(numberedPdf);
    return { ...normalized, unavailableImages, html: paginatedHtml };
  } finally {
    await browser.close();
  }
}
