import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { wikiQueries } from "./wiki";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wiki queries", () => {
  it("reuses a fresh index response", async () => {
    const request = vi.fn(() => Promise.resolve(Response.json({ sources: [], links: [] })));
    vi.stubGlobal("fetch", request);
    const queryClient = new QueryClient();

    await queryClient.fetchQuery(wikiQueries.index);
    await queryClient.fetchQuery(wikiQueries.index);

    expect(request).toHaveBeenCalledOnce();
  });
});
