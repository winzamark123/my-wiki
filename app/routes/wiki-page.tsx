import { env } from "cloudflare:workers";
import { data, Link } from "react-router";

import type { Route } from "./+types/wiki-page";
import { RedLinkPage } from "~/components/red-link-page";
import { renderMarkdown } from "~/lib/markdown.server";
import { referringPages } from "~/lib/wiki";
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
    // missing targets generate only after this page hydrates, never from a crawler GET
    const isRedLink = referringPages(index, params.slug).length > 0;
    return data(
      { slug: params.slug, title: null, html: null, index, isRedLink },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return {
    slug: page.slug,
    title: page.title,
    html: renderMarkdown(page.body, index),
    index: null,
    isRedLink: false,
  };
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
      {html === null && loaderData.isRedLink ? (
        <RedLinkPage key={slug} slug={slug} index={loaderData.index} />
      ) : html === null ? (
        <>
          <h1 className="text-2xl font-semibold text-destructive/80">{slug}</h1>
          <p className="mt-6 text-muted-foreground">
            This page hasn't been written yet. Drop something into the input box to bring it
            to life.
          </p>
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
