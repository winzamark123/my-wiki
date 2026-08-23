import { describe, expect, it } from "vitest";

import { buildGraph } from "./graph";

const source = (id: string, state: "queued" | "reading" | "archived", near: string[] = []) => ({
  matter_id: id,
  title: id,
  url: `https://example.com/${id}`,
  content_type: "article",
  state,
  progress: state === "reading" ? 0.5 : 0,
  favorite: false,
  matter_updated_at: "2026-08-22T00:00:00Z",
  near,
});

describe("buildGraph", () => {
  it("derives solid edges from links and cites and dotted edges from near", () => {
    const graph = buildGraph({
      pages: [
        { slug: "a", title: "A", summary: "", links: ["b", "missing"], cites: ["itm_1", "itm_gone"] },
        { slug: "b", title: "B", summary: "", links: [], cites: [] },
      ],
      sources: [source("itm_1", "archived"), source("itm_2", "reading", ["a", "nope"]), source("itm_3", "queued")],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["wiki:a", "wiki:b", "itm_1", "itm_2", "itm_3"]);
    expect(graph.edges.map((e) => [e.source, e.target, e.dotted])).toEqual([
      ["wiki:a", "wiki:b", false],
      ["wiki:a", "itm_1", false],
      ["itm_2", "wiki:a", true],
    ]);
  });

  it("sizes source nodes by word count within bounds", () => {
    const graph = buildGraph({
      pages: [],
      sources: [
        { ...source("short", "queued"), word_count: 50 },
        { ...source("long", "queued"), word_count: 20000 },
      ],
    });
    const [short, long] = graph.nodes;
    expect(short.r).toBeGreaterThanOrEqual(4);
    expect(long.r).toBeLessThanOrEqual(16);
    expect(long.r).toBeGreaterThan(short.r);
  });
});
