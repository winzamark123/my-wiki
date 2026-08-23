import { describe, expect, it } from "vitest";

import type { MatterItem } from "./matter.server";
import { deriveState, serializeSource, sourceFrontmatterSchema, sourceMetaFromItem } from "./sources";
import { parseFrontmatter } from "./wiki";

const item: MatterItem = {
  id: "itm_abc",
  title: "  A title\nwith a newline  ",
  url: "https://example.com/post",
  site_name: "example.com",
  author: { name: "Jane Doe" },
  status: "queue",
  processing_status: "completed",
  is_favorite: true,
  content_type: "article",
  word_count: 1200,
  reading_progress: 0.4,
  excerpt: "line one\nline two",
  updated_at: "2026-08-22T10:00:00Z",
};

describe("deriveState", () => {
  it("maps archive to archived regardless of progress", () => {
    expect(deriveState({ status: "archive", reading_progress: 0 })).toBe("archived");
    expect(deriveState({ status: "archive", reading_progress: 1 })).toBe("archived");
  });
  it("splits the queue by progress", () => {
    expect(deriveState({ status: "queue", reading_progress: 0 })).toBe("queued");
    expect(deriveState({ status: "queue", reading_progress: 0.01 })).toBe("reading");
  });
});

describe("sourceMetaFromItem", () => {
  it("flattens multi-line fields and keeps the wiki-owned timestamps", () => {
    const meta = sourceMetaFromItem({ item, now: "2026-08-22T12:00:00Z" });
    expect(meta.title).toBe("A title with a newline");
    expect(meta.excerpt).toBe("line one line two");
    expect(meta.state).toBe("reading");
    expect(meta.archived_at).toBeUndefined();
  });

  it("sets archived_at on the first archived sync and preserves it afterwards", () => {
    const first = sourceMetaFromItem({
      item: { ...item, status: "archive" },
      now: "2026-08-22T12:00:00Z",
    });
    expect(first.archived_at).toBe("2026-08-22T12:00:00Z");
    const later = sourceMetaFromItem({
      item: { ...item, status: "archive", updated_at: "2026-08-23T00:00:00Z" },
      previous: { ...first, synthesized_at: "2026-08-22T13:00:00Z" },
      now: "2026-08-23T01:00:00Z",
    });
    expect(later.archived_at).toBe("2026-08-22T12:00:00Z");
    expect(later.synthesized_at).toBe("2026-08-22T13:00:00Z");
  });
});

describe("serializeSource", () => {
  it("round-trips through parseFrontmatter and the schema", () => {
    const meta = sourceMetaFromItem({ item, now: "2026-08-22T12:00:00Z" });
    const raw = serializeSource({ meta, body: "# Body\n\nText: with colon" });
    const { attrs, body } = parseFrontmatter(raw);
    expect(body).toBe("# Body\n\nText: with colon");
    expect(sourceFrontmatterSchema.parse(attrs)).toEqual(meta);
  });
});
