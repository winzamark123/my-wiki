import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, type ErrorComponentProps } from "@tanstack/react-router";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => <Outlet />,
  errorComponent: ErrorPage,
  notFoundComponent: () => <ErrorPage title="404" details="The requested page could not be found." />,
});

function ErrorPage({
  error,
  title = "Oops!",
  details,
}: Partial<ErrorComponentProps> & { title?: string; details?: string }) {
  const message = details ?? (error instanceof Error ? error.message : "An unexpected error occurred.");
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <nav className="mb-8 text-sm text-muted-foreground">
        <Link to="/" className="hover:underline">
          ← index
        </Link>
      </nav>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-6 text-muted-foreground">{message}</p>
      {import.meta.env.DEV && error instanceof Error && error.stack && (
        <pre className="mt-6 w-full overflow-x-auto rounded border border-border bg-card p-4 text-xs">
          <code>{error.stack}</code>
        </pre>
      )}
    </main>
  );
}
