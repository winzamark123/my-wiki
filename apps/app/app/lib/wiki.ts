import { z } from "zod";

import { sourceMetaSchema } from "./sources";

// one labeled link per related pair of sources; see ARCHITECTURE.md → Links
export const linkSchema = z.object({ a: z.string(), b: z.string(), label: z.string() });

// index.json: everything the graph needs, rebuilt after every sync
export const wikiIndexSchema = z.object({
  sources: z.array(sourceMetaSchema),
  links: z.array(linkSchema),
});

export type WikiIndex = z.infer<typeof wikiIndexSchema>;
export type IndexSource = z.infer<typeof sourceMetaSchema>;
export type Link = z.infer<typeof linkSchema>;
