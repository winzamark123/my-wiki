import { queryOptions } from "@tanstack/react-query";
import { apiIndexSchema, sourceResponseSchema } from "@my-wiki/server-app/wiki";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8787";
const INDEX_STALE_TIME = 60_000;
const SOURCE_STALE_TIME = 5 * 60_000;

const wikiKeys = {
  all: ["wiki"] as const,
  index: () => [...wikiKeys.all, "index"] as const,
  source: ({ id }: { id: string }) => [...wikiKeys.all, "source", id] as const,
};

async function getIndex({ signal }: { signal: AbortSignal }) {
  const response = await fetch(new URL("/api/index", API_URL), { signal });
  if (!response.ok) throw new Error(`server index request failed with ${response.status}`);
  return apiIndexSchema.parse(await response.json());
}

async function getSource({ id, signal }: { id: string; signal: AbortSignal }) {
  const response = await fetch(new URL(`/api/sources/${encodeURIComponent(id)}`, API_URL), { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`server source request failed with ${response.status}`);
  return sourceResponseSchema.parse(await response.json());
}

export const wikiQueries = {
  index: queryOptions({
    queryKey: wikiKeys.index(),
    queryFn: ({ signal }) => getIndex({ signal }),
    staleTime: INDEX_STALE_TIME,
  }),
  source: ({ id }: { id: string }) =>
    queryOptions({
      queryKey: wikiKeys.source({ id }),
      queryFn: ({ signal }) => getSource({ id, signal }),
      staleTime: SOURCE_STALE_TIME,
    }),
};
