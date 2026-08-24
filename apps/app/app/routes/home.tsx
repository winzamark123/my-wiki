import { env } from "cloudflare:workers";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/home";
import { Graph, SourceGlyph } from "~/components/graph";
import { ThemeToggle } from "~/components/theme-toggle";
import { sourceStates } from "~/lib/sources";
import type { IndexSource } from "~/lib/wiki";
import { CACHE_HEADERS, getIndex } from "~/lib/wiki.server";

export function meta() {
  return [{ title: "Wiki" }];
}

export function headers() {
  return CACHE_HEADERS;
}

export async function loader() {
  const { sources, links } = await getIndex(env.WIKI);
  // the graph doesn't need excerpts; keep the payload small
  return { sources: sources.map(({ excerpt: _excerpt, ...rest }) => rest), links };
}

type State = IndexSource["state"];

const chipClass = (active: boolean) =>
  `rounded-full border px-3 py-1 text-sm ${active ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:border-foreground"}`;

function sourceFacts(source: Pick<IndexSource, "site" | "state" | "progress">) {
  return [source.site, source.state === "reading" ? `${Math.round(source.progress * 100)}%` : null]
    .filter((f): f is string => Boolean(f))
    .join(" · ");
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { sources, links } = loaderData;
  const [view, setView] = useState<"graph" | "list">("graph");
  const [states, setStates] = useState<Set<State>>(new Set(sourceStates));
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [site, setSite] = useState("");
  const [minWords, setMinWords] = useState(0);

  const counts = useMemo(
    () => Object.fromEntries(sourceStates.map((state) => [state, sources.filter((s) => s.state === state).length])),
    [sources],
  );
  const sites = useMemo(
    () => [...new Set(sources.map((s) => s.site).filter((s): s is string => Boolean(s)))].sort(),
    [sources],
  );
  const visible = useMemo(
    () =>
      sources.filter(
        (s) =>
          states.has(s.state) &&
          (!favoritesOnly || s.favorite) &&
          (!site || s.site === site) &&
          (s.word_count ?? 0) >= minWords,
      ),
    [sources, states, favoritesOnly, site, minWords],
  );

  function toggleState(state: State) {
    setStates((prev) => {
      const next = new Set(prev);
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
          {(["graph", "list"] as const).map((v) => (
            <button key={v} type="button" className={chipClass(view === v)} onClick={() => setView(v)}>
              {v}
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
        <button type="button" className={chipClass(favoritesOnly)} onClick={() => setFavoritesOnly((v) => !v)}>
          favorites
        </button>
        <select
          value={site}
          onChange={(e) => setSite(e.target.value)}
          className="rounded-full border border-border bg-background px-3 py-1"
        >
          <option value="">all sites</option>
          {sites.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={minWords}
          onChange={(e) => setMinWords(Number(e.target.value))}
          className="rounded-full border border-border bg-background px-3 py-1"
        >
          {[0, 1000, 3000, 5000].map((n) => (
            <option key={n} value={n}>
              {n ? `${n.toLocaleString()}+ words` : "any length"}
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
            const items = visible.filter((s) => s.state === state);
            if (items.length === 0) return null;
            return (
              <section key={state}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {state} · {items.length}
                </h2>
                <ul className="space-y-2">
                  {items.map((s) => (
                    <li key={s.matter_id} className="flex gap-2">
                      <svg width={16} height={16} viewBox="-8 -8 16 16" className="mt-1 shrink-0" aria-hidden>
                        <SourceGlyph r={5} state={s.state} progress={s.progress} />
                      </svg>
                      <p>
                        <Link to={`/source/${s.matter_id}`} className="hover:underline">
                          {s.title}
                        </Link>{" "}
                        <span className="text-xs text-muted-foreground">{sourceFacts(s)}</span>
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
