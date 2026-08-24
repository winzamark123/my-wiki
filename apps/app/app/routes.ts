import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [index("routes/home.tsx"), route("source/:id", "routes/source.tsx")] satisfies RouteConfig;
