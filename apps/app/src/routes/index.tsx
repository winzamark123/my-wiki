import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { sourceStates } from "@my-wiki/server-app/sources";
import type { IndexSource } from "@my-wiki/server-app/wiki";
import { useEffect, useMemo, useState } from "react";

import { Graph, SourceGlyph } from "@/components/graph";
import { ThemeToggle } from "@/components/theme-toggle";
import { wikiQueries } from "@/api/wiki";

export const Route = createFileRoute("/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(wikiQueries.index),
  component: Home,
});

type State = IndexSource["state"];

const chipClass = (active: boolean) =>
  `rounded-full border px-3 py-1 text-sm ${active ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:border-foreground"}`;

function sourceFacts(source: Pick<IndexSource, "site" | "state" | "progress">) {
  return [source.site, source.state === "reading" ? `${Math.round(source.progress * 100)}%` : null]
    .filter((fact): fact is string => Boolean(fact))
    .join(" · ");
}

function Home() {
  const { data } = useSuspenseQuery(wikiQueries.index);
  const { sources, links } = data;
  const [view, setView] = useState<"graph" | "list">("graph");
  const [states, setStates] = useState<Set<State>>(new Set(sourceStates));
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [site, setSite] = useState("");
  const [minWords, setMinWords] = useState(0);

  useEffect(() => {
    document.title = "Wiki";
  }, []);

  const counts = useMemo(
    () => Object.fromEntries(sourceStates.map((state) => [state, sources.filter((source) => source.state === state).length])),
    [sources],
  );
  const sites = useMemo(
    () => [...new Set(sources.map((source) => source.site).filter((value): value is string => Boolean(value)))].sort(),
    [sources],
  );
  const visible = useMemo(
    () =>
      sources.filter(
        (source) =>
          states.has(source.state) &&
          (!favoritesOnly || source.favorite) &&
          (!site || source.site === site) &&
          (source.word_count ?? 0) >= minWords,
      ),
    [sources, states, favoritesOnly, site, minWords],
  );

  function toggleState(state: State) {
    setStates((previous) => {
      const next = new Set(previous);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">Wiki</h1>
        <div className="flex gap-2">
          {(["graph", "list"] as const).map((nextView) => (
            <button
              key={nextView}
              type="button"
              className={chipClass(view === nextView)}
              onClick={() => setView(nextView)}
            >
              {nextView}
            </button>
          ))}
          <ThemeToggle className={`${chipClass(false)} px-2`} />
        </div>
      </header>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {sourceStates.map((state) => (
          <button key={state} type="button" className={chipClass(states.has(state))} onClick={() => toggleState(state)}>
            {state} · {counts[state]}
          </button>
        ))}
        <button type="button" className={chipClass(favoritesOnly)} onClick={() => setFavoritesOnly((value) => !value)}>
          favorites
        </button>
        <select
          value={site}
          onChange={(event) => setSite(event.target.value)}
          className="rounded-full border border-border bg-background px-3 py-1"
        >
          <option value="">all sites</option>
          {sites.map((sourceSite) => (
            <option key={sourceSite} value={sourceSite}>
              {sourceSite}
            </option>
          ))}
        </select>
        <select
          value={minWords}
          onChange={(event) => setMinWords(Number(event.target.value))}
          className="rounded-full border border-border bg-background px-3 py-1"
        >
          {[0, 1000, 3000, 5000].map((wordCount) => (
            <option key={wordCount} value={wordCount}>
              {wordCount ? `${wordCount.toLocaleString()}+ words` : "any length"}
            </option>
          ))}
        </select>
        <span className="ml-auto text-muted-foreground">
          {visible.length} of {sources.length} sources
        </span>
      </div>

      {view === "graph" ? (
        <Graph sources={visible} links={links} />
      ) : (
        <div className="grid gap-8 md:grid-cols-3">
          {sourceStates.map((state) => {
            const items = visible.filter((source) => source.state === state);
            if (items.length === 0) return null;
            return (
              <section key={state}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {state} · {items.length}
                </h2>
                <ul className="space-y-2">
                  {items.map((source) => (
                    <li key={source.matter_id} className="flex gap-2">
                      <svg width={16} height={16} viewBox="-8 -8 16 16" className="mt-1 shrink-0" aria-hidden>
                        <SourceGlyph r={5} state={source.state} progress={source.progress} />
                      </svg>
                      <p>
                        <Link to="/source/$id" params={{ id: source.matter_id }} className="hover:underline">
                          {source.title}
                        </Link>{" "}
                        <span className="text-xs text-muted-foreground">{sourceFacts(source)}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
