import { describe, expect, it } from "vitest";

import { buildGraph } from "./graph";

const source = (id: string, state: "queued" | "reading" | "archived") => ({
  matter_id: id,
  title: id,
  url: `https://example.com/${id}`,
  content_type: "article",
  state,
  progress: state === "reading" ? 0.5 : 0,
  favorite: false,
  matter_updated_at: "2026-08-22T00:00:00Z",
});

describe("buildGraph", () => {
  it("keeps links whose both ends are visible", () => {
    const graph = buildGraph({
      sources: [source("itm_1", "archived"), source("itm_2", "reading")],
      links: [
        { a: "itm_1", b: "itm_2", label: "both on x" },
        { a: "itm_2", b: "itm_hidden", label: "filtered out" },
      ],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["itm_1", "itm_2"]);
    expect(graph.edges.map((e) => [e.source, e.target, e.label])).toEqual([["itm_1", "itm_2", "both on x"]]);
  });

  it("sizes nodes by word count within bounds", () => {
    const graph = buildGraph({
      sources: [
        { ...source("short", "queued"), word_count: 50 },
        { ...source("long", "queued"), word_count: 20000 },
      ],
      links: [],
    });
    const [short, long] = graph.nodes;
    expect(short.r).toBeGreaterThanOrEqual(4);
    expect(long.r).toBeLessThanOrEqual(16);
    expect(long.r).toBeGreaterThan(short.r);
  });
});
