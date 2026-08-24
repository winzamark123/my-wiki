import { env } from "cloudflare:workers";
import { apiIndexSchema, sourceResponseSchema } from "@my-wiki/server-app/wiki";

function serverUrl(path: string) {
  return new URL(path, env.SERVER_URL);
}

export async function getIndex() {
  const response = await fetch(serverUrl("/api/index"));
  if (!response.ok) throw new Error(`server index request failed with ${response.status}`);
  return apiIndexSchema.parse(await response.json());
}

export async function getSource({ id }: { id: string }) {
  const response = await fetch(serverUrl(`/api/sources/${encodeURIComponent(id)}`));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`server source request failed with ${response.status}`);
  return sourceResponseSchema.parse(await response.json());
}
