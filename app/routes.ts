import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("wiki/:slug", "routes/wiki-page.tsx"),
  route("api/input", "routes/api.input.ts"),
  route("api/jobs/:id", "routes/api.jobs.ts"),
  route("api/reindex", "routes/api.reindex.ts"),
] satisfies RouteConfig;
