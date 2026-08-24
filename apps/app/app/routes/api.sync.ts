import { env } from "cloudflare:workers";
import { data } from "react-router";

import type { Route } from "./+types/api.sync";

// POST starts a sync (?full=1 ignores the cursor); GET ?id= reports an instance's status
export async function action({ request }: Route.ActionArgs) {
  const full = new URL(request.url).searchParams.has("full");
  const instance = await env.MATTER_SYNC.create({ params: { full } });
  return { id: instance.id };
}

export async function loader({ request }: Route.LoaderArgs) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return data({ error: "id is required" }, { status: 400 });
  try {
    const instance = await env.MATTER_SYNC.get(id);
    return instance.status();
  } catch {
    return data({ error: "unknown instance" }, { status: 404 });
  }
}
