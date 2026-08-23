import { env } from "cloudflare:workers";
import { data, Link } from "react-router";

import type { Route } from "./+types/source";
import { renderPlainMarkdown } from "~/lib/markdown.server";
import { getSource } from "~/lib/sources.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `${loaderData.meta.title} · Source` : "Source" }];
}

// private: copies of other people's articles are never edge-cached
export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export async function loader({ params }: Route.LoaderArgs) {
  const source = await getSource(env.WIKI, params.id);
  if (!source) throw data("source not found", { status: 404 });
  return { meta: source.meta, html: renderPlainMarkdown(source.body) };
}

export default function Source({ loaderData }: Route.ComponentProps) {
  const { meta, html } = loaderData;
  const facts = [
    meta.author,
    meta.site,
    meta.word_count ? `${meta.word_count.toLocaleString()} words` : null,
    meta.state === "reading" ? `${Math.round(meta.progress * 100)}% read` : meta.state,
    meta.favorite ? "favorite" : null,
  ].filter((f): f is string => Boolean(f));

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <nav className="mb-8 text-sm text-muted-foreground">
        <Link to="/" className="hover:underline">
          ← index
        </Link>
      </nav>
      <header className="mb-8 border-l-4 border-muted pl-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Source</p>
        <h1 className="mt-1 text-2xl font-semibold">{meta.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{facts.join(" · ")}</p>
        <a href={meta.url} className="mt-1 block text-sm hover:underline" rel="noreferrer">
          {meta.url}
        </a>
      </header>
      <article
        className="prose prose-neutral dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </main>
  );
}
