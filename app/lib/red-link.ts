import { z } from "zod";

export const wikiPageSnapshotSchema = z.string().min(1);

export type RedLinkStreamDataParts = {
  "wiki-page": z.infer<typeof wikiPageSnapshotSchema>;
};
