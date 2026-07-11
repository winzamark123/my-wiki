import { env } from "cloudflare:workers";
import { Link } from "react-router";

import type { Route } from "./+types/home";
import { CACHE_HEADERS, getIndex } from "~/lib/wiki.server";

export function meta() {
  return [{ title: "Wiki" }];
}

export function headers() {
  return CACHE_HEADERS;
}

export async function loader() {
  const index = await getIndex(env.WIKI);
  return { pages: index.pages };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { pages } = loaderData;
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Wiki</h1>
      {pages.length === 0 ? (
        <p className="mt-6 text-muted-foreground">
          Nothing here yet. Drop a thought into the input box to create the first page.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {pages.map((page) => (
            <li key={page.slug}>
              <Link to={`/wiki/${page.slug}`} className="font-medium hover:underline">
                {page.title}
              </Link>
              {page.summary && (
                <p className="text-sm text-muted-foreground">{page.summary}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
