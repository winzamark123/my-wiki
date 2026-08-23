import { env } from "cloudflare:workers";
import { data, Link } from "react-router";

import type { Route } from "./+types/wiki-page";
import { renderMarkdown } from "~/lib/markdown.server";
import { CACHE_HEADERS, getIndex, getPage } from "~/lib/wiki.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.title ? `${loaderData.title} · Wiki` : "Wiki" }];
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  const cacheControl = loaderHeaders.get("Cache-Control");
  return cacheControl ? { "Cache-Control": cacheControl } : CACHE_HEADERS;
}

export async function loader({ params }: Route.LoaderArgs) {
  const [page, index] = await Promise.all([
    getPage(env.WIKI, params.slug),
    getIndex(env.WIKI),
  ]);
  if (!page) {
    return data({ slug: params.slug, title: null, html: null }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return { slug: page.slug, title: page.title, html: renderMarkdown(page.body, index) };
}

export default function WikiPage({ loaderData }: Route.ComponentProps) {
  const { slug, html } = loaderData;
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <nav className="mb-8 text-sm text-muted-foreground">
        <Link to="/" className="hover:underline">
          ← index
        </Link>
      </nav>
      {html === null ? (
        <>
          <h1 className="text-2xl font-semibold">{slug}</h1>
          <p className="mt-6 text-muted-foreground">No topic page with this name yet.</p>
        </>
      ) : (
        <article
          className="prose prose-neutral dark:prose-invert"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </main>
  );
}
