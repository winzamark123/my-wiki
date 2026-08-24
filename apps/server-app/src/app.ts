import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

import { linkSources } from "./links";
import { getSource } from "./source-store";
import { apiIndexSchema } from "./wiki";
import { getIndex, regenerateIndex } from "./wiki-index";

const syncQuerySchema = z.object({ full: z.literal("1").optional() });

export const app = new Hono<{ Bindings: Env }>()
  .get("/health", (c) => c.json({ status: "ok" }))
  .use("/api/*", (c, next) => cors({ origin: c.env.FRONTEND_URL })(c, next))
  .get("/api/index", async (c) => {
    const { sources, links } = await getIndex(c.env.WIKI);
    const index = apiIndexSchema.parse({
      sources: sources.map(({ excerpt: _excerpt, ...source }) => source),
      links,
    });
    c.header("Cache-Control", "public, max-age=0, s-maxage=60");
    return c.json(index);
  })
  .get("/api/sources/:id", async (c) => {
    const source = await getSource(c.env.WIKI, c.req.param("id"));
    if (!source) return c.json({ error: "source not found" }, 404);
    c.header("Cache-Control", "private, no-store");
    return c.json(source);
  })
  .post("/api/sync", async (c) => {
    const query = syncQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "full must be 1" }, 400);
    const instance = await c.env.MATTER_SYNC.create({ params: { full: query.data.full === "1" } });
    return c.json({ id: instance.id }, 202);
  })
  .get("/api/sync/:id", async (c) => {
    try {
      const instance = await c.env.MATTER_SYNC.get(c.req.param("id"));
      return c.json(await instance.status());
    } catch {
      return c.json({ error: "unknown instance" }, 404);
    }
  })
  .post("/api/reindex", async (c) => {
    if (c.env.ENVIRONMENT !== "development") return c.json({ error: "not found" }, 404);
    const { pending } = await regenerateIndex(c.env.WIKI, c.env.AI);
    if (pending.length === 0) return c.json({ linked: 0 });
    await linkSources({ bucket: c.env.WIKI, ai: c.env.AI, ids: pending });
    const { sources, links } = await regenerateIndex(c.env.WIKI, c.env.AI);
    return c.json({ sources, linked: pending.length, links });
  })
  .notFound((c) => c.json({ error: "not found" }, 404))
  .onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal server error" }, 500);
  });
