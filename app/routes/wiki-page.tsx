import { env } from "cloudflare:workers";
import { data, Link } from "react-router";

import type { Route } from "./+types/wiki-page";
import { CACHE_HEADERS, getIndex, getPage } from "~/lib/wiki.server";
import { renderMarkdown } from "~/lib/markdown.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.title ? `${loaderData.title} · Wiki` : "Wiki" }];
}

export function headers() {
  return CACHE_HEADERS;
}

export async function loader({ params }: Route.LoaderArgs) {
  const [page, index] = await Promise.all([
    getPage(env.WIKI, params.slug),
    getIndex(env.WIKI),
  ]);
  if (!page) {
    // red-link target: a page that hasn't been written yet is an empty page, not an error
    return data({ slug: params.slug, title: null, html: null }, { status: 404 });
  }
  return { slug: page.slug, title: page.title, html: renderMarkdown(page.body, index) };
}

export default function WikiPage({ loaderData }: Route.ComponentProps) {
  const { slug, title, html } = loaderData;
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <nav className="mb-8 text-sm text-muted-foreground">
        <Link to="/" className="hover:underline">
          ← index
        </Link>
      </nav>
      {html === null ? (
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
