import { describe, expect, it } from "vitest";

import { latestSourceCutoff, materializeChapterPlan, normalizeChapterTitle, selectExportSources } from "./books";
import type { SourceMeta } from "./sources";

function source({
  id,
  state = "archived",
  archivedAt,
  url = `https://example.com/${id}`,
}: {
  id: string;
  state?: SourceMeta["state"];
  archivedAt?: string;
  url?: string;
}): SourceMeta {
  return {
    matter_id: id,
    title: id,
    url,
    content_type: "article",
    state,
    progress: state === "archived" ? 1 : 0,
    favorite: false,
    archived_at: archivedAt,
    matter_updated_at: "2026-08-25T00:00:00.000Z",
  };
}

describe("normalizeChapterTitle", () => {
  it("removes redundant model-generated chapter numbering", () => {
    expect(normalizeChapterTitle("Chapter 3: Boring Languages")).toBe("Boring Languages");
    expect(normalizeChapterTitle("Chapter IV — Quiet Machines")).toBe("Quiet Machines");
    expect(normalizeChapterTitle("Walls and Wealth")).toBe("Walls and Wealth");
  });
});

describe("latestSourceCutoff", () => {
  it("returns the newest completed export cutoff", () => {
    expect(
      latestSourceCutoff({
        exports: [
          { id: "book-2", source_cutoff: "2026-08-24T00:00:00.000Z", completed_at: "2026-08-24T01:00:00.000Z" },
          { id: "book-1", source_cutoff: "2026-08-23T00:00:00.000Z", completed_at: "2026-08-23T01:00:00.000Z" },
        ],
      }),
    ).toBe("2026-08-24T00:00:00.000Z");
  });
});

describe("selectExportSources", () => {
  const sources = [
    source({ id: "newer", archivedAt: "2026-08-24T00:00:00.000Z" }),
    source({ id: "older", archivedAt: "2026-08-22T00:00:00.000Z" }),
    source({ id: "future", archivedAt: "2026-08-26T00:00:00.000Z" }),
    source({ id: "queued", state: "queued" }),
  ];

  it("selects every archived source through the first export cutoff", () => {
    const selected = selectExportSources({
      sources,
      previousSourceCutoff: null,
      sourceCutoff: "2026-08-25T00:00:00.000Z",
    });
    expect(selected.map(({ matter_id }) => matter_id)).toEqual(["older", "newer"]);
  });

  it("selects only sources after the previous completed export", () => {
    const selected = selectExportSources({
      sources,
      previousSourceCutoff: "2026-08-23T00:00:00.000Z",
      sourceCutoff: "2026-08-25T00:00:00.000Z",
    });
    expect(selected.map(({ matter_id }) => matter_id)).toEqual(["newer"]);
  });

  it("excludes archived sources from X", () => {
    const selected = selectExportSources({
      sources: [
        source({ id: "article", archivedAt: "2026-08-24T00:00:00.000Z" }),
        source({ id: "x-post", archivedAt: "2026-08-24T00:00:00.000Z", url: "https://x.com/example/status/1" }),
      ],
      previousSourceCutoff: null,
      sourceCutoff: "2026-08-25T00:00:00.000Z",
    });
    expect(selected.map(({ matter_id }) => matter_id)).toEqual(["article"]);
  });

  it("fails rather than silently skipping an archived source without a timestamp", () => {
    expect(() =>
      selectExportSources({
        sources: [source({ id: "missing" })],
        previousSourceCutoff: null,
        sourceCutoff: "2026-08-25T00:00:00.000Z",
      }),
    ).toThrow("archived source missing is missing archived_at");
  });
});

describe("materializeChapterPlan", () => {
  it("converts compact source indexes back to Matter ids", () => {
    expect(
      materializeChapterPlan({
        plan: { title: "A Book", chapters: [{ title: "A chapter", sources: [2, 0, 1] }] },
        sourceIds: ["itm_a", "itm_b", "itm_c"],
        embeddingNeighbors: [[], [], []],
      }),
    ).toEqual({ title: "A Book", chapters: [{ title: "A chapter", sources: ["itm_c", "itm_a", "itm_b"] }] });
  });

  it("places a missing source with its closest planned neighbor", () => {
    expect(
      materializeChapterPlan({
        plan: {
          title: "A Book",
          chapters: [
            { title: "First chapter", sources: [0] },
            { title: "Second chapter", sources: [1] },
          ],
        },
        sourceIds: ["itm_a", "itm_b", "itm_c"],
        embeddingNeighbors: [[], [], [1, 0]],
      }),
    ).toEqual({
      title: "A Book",
      chapters: [
        { title: "First chapter", sources: ["itm_a"] },
        { title: "Second chapter", sources: ["itm_b", "itm_c"] },
      ],
    });
  });

  it("keeps the first placement of repeated sources and restores missing sources", () => {
    expect(
      materializeChapterPlan({
        plan: {
          title: "A Book",
          chapters: [
            { title: "First chapter", sources: [0, 0] },
            { title: "Second chapter", sources: [1] },
          ],
        },
        sourceIds: ["itm_a", "itm_b", "itm_c"],
        embeddingNeighbors: [[], [], [1]],
      }),
    ).toEqual({
      title: "A Book",
      chapters: [
        { title: "First chapter", sources: ["itm_a"] },
        { title: "Second chapter", sources: ["itm_b", "itm_c"] },
      ],
    });
  });

  it("rejects unknown source indexes", () => {
    expect(() =>
      materializeChapterPlan({
        plan: { title: "A Book", chapters: [{ title: "Bad chapter", sources: [0, 3] }] },
        sourceIds: ["itm_a", "itm_b", "itm_c"],
        embeddingNeighbors: [[], [], []],
      }),
    ).toThrow("unknown [3]");
  });
});
