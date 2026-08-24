import { afterEach, describe, expect, it, vi } from "vitest";

import { createMatterClient, parseLenientJson } from "./matter";

const baseItem = {
  id: "itm_1",
  title: "One",
  url: "https://example.com/1",
  status: "queue",
  processing_status: "completed",
  is_favorite: false,
  content_type: "article",
  reading_progress: 0,
  updated_at: "2026-08-22T10:00:00Z",
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("parseLenientJson", () => {
  it("accepts raw control characters inside strings", () => {
    const raw = '{"title":"bad\u0008title","n":1}';
    expect(() => JSON.parse(raw)).toThrow();
    expect(parseLenientJson(raw)).toEqual({ title: "bad\u0008title", n: 1 });
  });
});

describe("createMatterClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("walks cursor pagination and sends the expected query", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (!url.searchParams.get("cursor")) {
        return jsonResponse({ results: [baseItem], has_more: true, next_cursor: "c2" });
      }
      return jsonResponse({ results: [{ ...baseItem, id: "itm_2" }], has_more: false, next_cursor: null });
    });

    const client = createMatterClient({ token: "mat_test" });
    const ids: string[] = [];
    for await (const item of client.iterateItems({ status: ["queue", "archive"], updatedSince: "2026-01-01T00:00:00Z" })) {
      ids.push(item.id);
    }
    expect(ids).toEqual(["itm_1", "itm_2"]);
    expect(calls[0]).toContain("/v1/items?status=queue%2Carchive&order=updated&updated_since=2026-01-01T00%3A00%3A00Z&limit=100");
    expect(calls[1]).toContain("cursor=c2");
  });

  it("waits for Retry-After on a 429 and retries once", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts++;
      return attempts === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "2" } })
        : jsonResponse({ ...baseItem, markdown: "# hi" });
    });

    const pending = createMatterClient({ token: "mat_test" }).getItemWithMarkdown("itm_1");
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).markdown).toBe("# hi");
    expect(attempts).toBe(2);
    vi.useRealTimers();
  });

  it("throws with status and body on other errors", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":"forbidden"}', { status: 403 }));
    await expect(createMatterClient({ token: "mat_test" }).getItemWithMarkdown("itm_1")).rejects.toThrow("403");
  });
});
