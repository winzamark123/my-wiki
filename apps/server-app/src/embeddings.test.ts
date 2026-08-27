import { describe, expect, it } from "vitest";

import { nearestSources } from "./embeddings";

const unit = (x: number, y: number) => {
  const n = Math.hypot(x, y);
  return [x / n, y / n];
};

const store = {
  model: "test",
  dims: 2,
  vectors: {
    itm_a: { hash: "a", vector: unit(1, 0) },
    itm_close: { hash: "b", vector: unit(1, 0.2) },
    itm_closer: { hash: "c", vector: unit(1, 0.1) },
    itm_far: { hash: "d", vector: unit(0, 1) },
    itm_third: { hash: "e", vector: unit(1, 0.3) },
  },
};

describe("nearestSources", () => {
  it("returns the closest other sources, best first", () => {
    expect(nearestSources({ store, sourceId: "itm_a", count: 2 })).toEqual(["itm_closer", "itm_close"]);
  });

  it("limits results to candidate ids when provided", () => {
    expect(nearestSources({ store, sourceId: "itm_a", count: 2, candidateIds: new Set(["itm_far", "itm_third"]) })).toEqual([
      "itm_third",
      "itm_far",
    ]);
  });

  it("returns nothing for an unknown source", () => {
    expect(nearestSources({ store, sourceId: "itm_none", count: 2 })).toEqual([]);
  });
});
