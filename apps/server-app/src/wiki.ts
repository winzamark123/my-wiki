import { z } from "zod";

import { sourceMetaSchema } from "./sources";

// one labeled link per related pair of sources; see ARCHITECTURE.md → Links
export const linkSchema = z.object({ a: z.string(), b: z.string(), label: z.string() });

// index.json: everything the graph needs, rebuilt after every sync
export const wikiIndexSchema = z.object({
  sources: z.array(sourceMetaSchema),
  links: z.array(linkSchema),
});

// the public index omits excerpts; source bodies are served by their own endpoint
export const apiIndexSchema = wikiIndexSchema.extend({
  sources: z.array(sourceMetaSchema.omit({ excerpt: true })),
});

export const sourceResponseSchema = z.object({
  meta: sourceMetaSchema,
  body: z.string(),
});

export type WikiIndex = z.infer<typeof wikiIndexSchema>;
export type ApiIndex = z.infer<typeof apiIndexSchema>;
export type IndexSource = z.infer<typeof apiIndexSchema>["sources"][number];
export type Link = z.infer<typeof linkSchema>;
