import { env } from "cloudflare:workers";
import { data } from "react-router";

import { regenerateIndex } from "~/lib/wiki.server";

// dev-only: rebuild index.json after seeding the local bucket directly
export async function action() {
  if (!import.meta.env.DEV) {
    return data({ error: "not found" }, { status: 404 });
  }
  const index = await regenerateIndex(env.WIKI);
  return { pages: index.pages.length };
}
