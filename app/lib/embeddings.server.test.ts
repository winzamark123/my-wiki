import { describe, expect, it } from "vitest";

import { nearestPages, pageKey } from "./embeddings.server";

const unit = (x: number, y: number) => {
  const n = Math.hypot(x, y);
  return [x / n, y / n];
};

const store = {
  model: "test",
  dims: 2,
  vectors: {
    itm_a: { text: "a", vector: unit(1, 0) },
    [pageKey("close")]: { text: "p1", vector: unit(1, 0.2) },
    [pageKey("closer")]: { text: "p2", vector: unit(1, 0.1) },
    [pageKey("far")]: { text: "p3", vector: unit(0, 1) },
    [pageKey("third")]: { text: "p4", vector: unit(1, 0.3) },
  },
};

describe("nearestPages", () => {
  it("returns the two closest pages above the similarity floor, best first", () => {
    expect(nearestPages({ store, sourceId: "itm_a", pageSlugs: ["close", "far", "third", "closer"] })).toEqual([
      "closer",
      "close",
    ]);
  });

  it("ignores pages without vectors and unknown sources", () => {
    expect(nearestPages({ store, sourceId: "itm_a", pageSlugs: ["missing"] })).toEqual([]);
    expect(nearestPages({ store, sourceId: "itm_none", pageSlugs: ["close"] })).toEqual([]);
  });
});
