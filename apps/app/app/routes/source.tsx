import { data, Link } from "react-router";

import type { Route } from "./+types/source";
import { SourceGlyph } from "~/components/graph";
import { getIndex, getSource } from "~/lib/api.server";
import { renderMarkdown } from "~/lib/markdown.server";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData ? `${loaderData.meta.title} · Source` : "Source" }];
}

// private: copies of other people's articles are never edge-cached
export function headers() {
  return { "Cache-Control": "private, no-store" };
}

export async function loader({ params }: Route.LoaderArgs) {
  const [source, index] = await Promise.all([getSource({ id: params.id }), getIndex()]);
  if (!source) throw data("source not found", { status: 404 });
  const titles = new Map(index.sources.map((s) => [s.matter_id, s.title]));
  const related = index.links.flatMap(({ a, b, label }) => {
    const other = a === params.id ? b : b === params.id ? a : null;
    const title = other && titles.get(other);
    return other && title ? [{ id: other, title, label }] : [];
  });
  return { meta: source.meta, html: renderMarkdown(source.body), related };
}

// fixed locale and zone so server and client render the same string
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export default function Source({ loaderData }: Route.ComponentProps) {
  const { meta, html, related } = loaderData;
  const status =
    meta.state === "reading"
      ? `${Math.round(meta.progress * 100)}% read`
      : meta.state === "archived" && meta.archived_at
        ? `archived ${formatDate(meta.archived_at)}`
        : meta.state;
  const facts = [
    status,
    meta.author,
    meta.site,
    meta.word_count ? `${meta.word_count.toLocaleString()} words` : null,
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
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <svg width={16} height={16} viewBox="-8 -8 16 16" className="shrink-0" aria-hidden>
            <SourceGlyph r={5} state={meta.state} progress={meta.progress} />
          </svg>
          <span>{facts.join(" · ")}</span>
        </p>
        <a href={meta.url} className="mt-2 inline-block text-sm hover:underline" rel="noreferrer">
          Read on {meta.site ?? "the original site"} ↗
        </a>
      </header>
      <article
        className="prose prose-neutral dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {related.length > 0 && (
        <section className="mt-12 border-t border-border pt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Related</h2>
          <ul className="space-y-2">
            {related.map(({ id, title, label }) => (
              <li key={id}>
                <Link to={`/source/${id}`} className="hover:underline">
                  {title}
                </Link>{" "}
                <span className="text-sm text-muted-foreground">{label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
