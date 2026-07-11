import { env } from "cloudflare:workers";
import { data } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/api.input";

const inputSchema = z.object({
  text: z.string().trim().min(1),
  contextSlug: z.string().optional(),
});

export async function action({ request }: Route.ActionArgs) {
  const parsed = inputSchema.safeParse(await request.json());
  if (!parsed.success) {
    return data({ error: "text is required" }, { status: 400 });
  }
  const instance = await env.SYNTHESIS_WORKFLOW.create({ params: parsed.data });
  return { id: instance.id };
}
