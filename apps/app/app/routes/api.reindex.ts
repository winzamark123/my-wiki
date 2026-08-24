import { env } from "cloudflare:workers";
import { data } from "react-router";

import { linkSources } from "~/lib/links.server";
import { regenerateIndex } from "~/lib/wiki.server";

// dev-only: rebuild index.json, embeddings, and links after seeding the local bucket directly
export async function action() {
  if (!import.meta.env.DEV) {
    return data({ error: "not found" }, { status: 404 });
  }
  const { pending } = await regenerateIndex(env.WIKI, env.AI);
  if (pending.length === 0) return { linked: 0 };
  await linkSources({ bucket: env.WIKI, ai: env.AI, ids: pending });
  const { sources, links } = await regenerateIndex(env.WIKI, env.AI);
  return { sources, linked: pending.length, links };
}
