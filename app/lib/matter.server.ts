// Matter public API client. see ARCHITECTURE.md → External APIs → Matter
import { z } from "zod";

const BASE_URL = "https://api.getmatter.com/public/v1";

export const matterItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  site_name: z.string().nullish(),
  author: z.object({ name: z.string() }).nullish(),
  status: z.enum(["inbox", "queue", "archive"]).nullable(),
  processing_status: z.enum(["processing", "completed", "failed"]),
  is_favorite: z.boolean(),
  // kept open: Matter adds content types without versioning the API
  content_type: z.string(),
  word_count: z.number().nullish(),
  reading_progress: z.number(),
  excerpt: z.string().nullish(),
  markdown: z.string().nullish(),
  updated_at: z.string(),
});

export type MatterItem = z.infer<typeof matterItemSchema>;

const itemListSchema = z.object({
  results: z.array(matterItemSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullish(),
});

export type MatterStatus = "inbox" | "queue" | "archive";

// some titles carry raw control characters, which strict JSON rejects; escape them inside string literals only
export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const repaired = text.replace(/"(?:[^"\\]|\\.)*"/g, (literal) =>
      literal.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
    );
    return JSON.parse(repaired);
  }
}

export function createMatterClient({ token }: { token: string }) {
  async function get(path: string, params: Record<string, string | undefined> = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 429 && attempt === 0) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "10");
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      if (!response.ok) {
        throw new Error(`matter ${path} → ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      return parseLenientJson(await response.text());
    }
  }

  return {
    // one page of items; see iterateItems for the full walk
    async listItems({
      status,
      updatedSince,
      cursor,
    }: {
      status: MatterStatus[];
      updatedSince?: string;
      cursor?: string;
    }) {
      return itemListSchema.parse(
        await get("/items", {
          status: status.join(","),
          order: "updated",
          updated_since: updatedSince,
          limit: "100",
          cursor,
        }),
      );
    },

    async *iterateItems({ status, updatedSince }: { status: MatterStatus[]; updatedSince?: string }) {
      let cursor: string | undefined;
      do {
        const page = await this.listItems({ status, updatedSince, cursor });
        yield* page.results;
        cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
      } while (cursor);
    },

    // counts against the separate 20/min markdown limit
    async getItemWithMarkdown(id: string) {
      return matterItemSchema.parse(await get(`/items/${id}`, { include: "markdown" }));
    },
  };
}
