import { env } from "cloudflare:workers";
import { data } from "react-router";

import type { Route } from "./+types/api.red-link";
import { createRedLinkGenerationResponse } from "~/lib/red-link.server";
import { slugify } from "~/lib/wiki";

const INTERNAL_HEADER = "X-Resumable-Internal";

function parseSlug(value: string) {
  const slug = slugify(value);
  return slug && slug === value ? slug : null;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const slug = parseSlug(params.slug);
  if (!slug) return data({ error: "invalid slug" }, { status: 400 });

  const stub = env.RED_LINK_STREAM.getByName(`red-link/${slug}`);
  return stub.fetch(new Request(request.url, { method: "GET" }));
}

export async function action({ request, params }: Route.ActionArgs) {
  const slug = parseSlug(params.slug);
  if (!slug) return data({ error: "invalid slug" }, { status: 400 });

  const stub = env.RED_LINK_STREAM.getByName(`red-link/${slug}`);
  if (request.method === "DELETE") return stub.fetch(request);
  if (request.method !== "POST") {
    return data({ error: "method not allowed" }, { status: 405 });
  }
  if (request.headers.get(INTERNAL_HEADER) === "1") {
    return createRedLinkGenerationResponse({ env, request, slug });
  }

  return stub.fetch(request);
}
