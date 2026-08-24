import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("source/:id", "routes/source.tsx"),
  route("api/reindex", "routes/api.reindex.ts"),
  route("api/sync", "routes/api.sync.ts"),
] satisfies RouteConfig;
