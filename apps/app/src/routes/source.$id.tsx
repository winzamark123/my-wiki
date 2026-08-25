import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { SourceGlyph } from "@/components/graph";
import { wikiQueries } from "@/api/wiki";
import { renderMarkdown } from "@/lib/markdown";

export const Route = createFileRoute("/source/$id")({
  loader: async ({ context, params }) => {
    const source = await context.queryClient.ensureQueryData(wikiQueries.source({ id: params.id }));
    if (!source) throw notFound();
    await context.queryClient.ensureQueryData(wikiQueries.index);
  },
  component: Source,
});

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function Source() {
  const { id } = Route.useParams();
  const { data: source } = useSuspenseQuery(wikiQueries.source({ id }));
  const { data: index } = useSuspenseQuery(wikiQueries.index);
  useEffect(() => {
    if (source) document.title = `${source.meta.title} · Source`;
  }, [source]);

  const related = useMemo(() => {
    const titles = new Map(index.sources.map((item) => [item.matter_id, item.title]));
    return index.links.flatMap(({ a, b, label }) => {
      const other = a === id ? b : b === id ? a : null;
      const title = other && titles.get(other);
      return other && title ? [{ id: other, title, label }] : [];
    });
  }, [id, index]);
  const html = useMemo(() => (source ? renderMarkdown(source.body) : ""), [source]);

  if (!source) throw notFound();
  const { meta } = source;
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
  ].filter((fact): fact is string => Boolean(fact));

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
      <article className="prose prose-neutral font-serif dark:prose-invert" dangerouslySetInnerHTML={{ __html: html }} />
      {related.length > 0 && (
        <section className="mt-12 border-t border-border pt-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Related</h2>
          <ul className="space-y-2">
            {related.map(({ id: relatedId, title, label }) => (
              <li key={relatedId}>
                <Link to="/source/$id" params={{ id: relatedId }} className="hover:underline">
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
