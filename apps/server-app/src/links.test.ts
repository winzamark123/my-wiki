import { describe, expect, it } from "vitest";

import { pairKey, pendingSources, relatedLinks } from "./links";

describe("pairKey", () => {
  it("is order independent", () => {
    expect(pairKey("itm_b", "itm_a")).toBe(pairKey("itm_a", "itm_b"));
  });
});

describe("pendingSources", () => {
  it("lists sources never linked or linked against an older text", () => {
    const store = {
      model: "m",
      dims: 2,
      vectors: { itm_a: { hash: "h1", vector: [1, 0] }, itm_b: { hash: "h2", vector: [0, 1] }, itm_c: { hash: "h3", vector: [1, 1] } },
    };
    const links = { pairs: {}, evaluated: { itm_a: "h1", itm_b: "old" } };
    expect(pendingSources({ store, links })).toEqual(["itm_b", "itm_c"]);
  });
});

describe("relatedLinks", () => {
  it("keeps accepted pairs between existing sources only", () => {
    const links = {
      pairs: {
        [pairKey("itm_a", "itm_b")]: { label: "both on x" },
        [pairKey("itm_a", "itm_c")]: { label: null },
        [pairKey("itm_b", "itm_gone")]: { label: "stale" },
      },
      evaluated: {},
    };
    expect(relatedLinks({ links, ids: new Set(["itm_a", "itm_b", "itm_c"]) })).toEqual([
      { a: "itm_a", b: "itm_b", label: "both on x" },
    ]);
  });
});
