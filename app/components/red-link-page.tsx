import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { LoaderCircle } from "lucide-react";
import { useRevalidator } from "react-router";
import { Streamdown } from "streamdown";

import { Button } from "~/components/ui/button";
import {
  wikiPageSnapshotSchema,
  type RedLinkStreamDataParts,
} from "~/lib/red-link";
import { parseFrontmatter, prepareStreamingMarkdown, type WikiIndex } from "~/lib/wiki";

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function RedLinkPage({ slug, index }: { slug: string; index: WikiIndex }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [resumeMissed, setResumeMissed] = useState(false);
  const hasSubmitted = useRef(false);
  const revalidator = useRevalidator();
  const api = `/api/wiki/${slug}/generate`;
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (init?.method === "GET" && response.status === 204) setResumeMissed(true);
          return response;
        },
        prepareSendMessagesRequest: () => ({ body: {} }),
        prepareReconnectToStreamRequest: () => ({ api }),
      }),
    [api],
  );
  const { sendMessage, status, error } = useChat<
    UIMessage<unknown, RedLinkStreamDataParts>
  >({
    id: `red-link-${slug}`,
    transport,
    resume: true,
    onData: (part) => {
      if (part.type !== "data-wiki-page") return;
      const snapshot = wikiPageSnapshotSchema.safeParse(part.data);
      if (snapshot.success) setDraft(snapshot.data);
    },
    onError: (streamError) => {
      console.error(streamError);
    },
    onFinish: ({ isAbort, isError }) => {
      if (!isAbort && !isError) revalidator.revalidate();
    },
    experimental_throttle: 50,
  });

  useEffect(() => {
    if (!resumeMissed || hasSubmitted.current) return;
    hasSubmitted.current = true;
    void sendMessage();
  }, [resumeMissed, sendMessage]);

  const parsedDraft = useMemo(() => (draft ? parseFrontmatter(draft) : null), [draft]);
  const body = useMemo(
    () =>
      parsedDraft
        ? prepareStreamingMarkdown({ body: parsedDraft.body, index })
        : "",
    [index, parsedDraft],
  );
  const existingSlugs = useMemo(
    () => new Set(index.pages.map((page) => page.slug)),
    [index.pages],
  );
  const isStreaming = status === "submitted" || status === "streaming";
  const title = parsedDraft?.attrs.title ?? titleFromSlug(slug);

  function retry() {
    setDraft(null);
    hasSubmitted.current = true;
    void sendMessage();
  }

  return (
    <section aria-live="polite">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {body ? (
        <Streamdown
          mode={isStreaming ? "streaming" : "static"}
          isAnimating={isStreaming}
          caret="circle"
          className="prose prose-neutral dark:prose-invert mt-6"
          components={{
            a: ({ href, children, ...props }) => {
              const wikiSlug = href?.startsWith("/wiki/")
                ? href.slice("/wiki/".length)
                : null;
              const isRedLink = Boolean(wikiSlug && !existingSlugs.has(wikiSlug));
              return (
                <a
                  {...props}
                  href={href}
                  data-wiki-link={wikiSlug ? true : undefined}
                  data-red-link={isRedLink ? true : undefined}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {body}
        </Streamdown>
      ) : !error ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Generating page…
        </p>
      ) : null}
      {error ? (
        <div className="mt-6 border-l-2 border-destructive/40 pl-3">
          <p className="text-sm text-destructive">Page generation failed.</p>
          <Button className="mt-3" size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  );
}
