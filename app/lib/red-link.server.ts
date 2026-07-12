import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import {
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  Output,
  streamText,
  type UIMessage,
} from "ai";
import { z } from "zod";

import { gatewayHeaders } from "./ai-gateway";
import type { RedLinkStreamDataParts } from "./red-link";
import {
  indexForPrompt,
  referringPages,
  resolveSlug,
  WIKI_LINK_RE_G,
  type WikiIndex,
} from "./wiki";
import { getIndex, getPage, getPageRaw, writePage } from "./wiki.server";

const generatedPageSchema = z.object({
  title: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).max(10),
  body: z.string().trim().min(1),
});

const SYSTEM_PROMPT = `You write one durable page for a personal wiki.

The page must be a readable, narrative article rather than terse notes or an encyclopedia entry. Use only the supplied wiki context. Connect the topic to the owner's existing interests when the context supports it.

Conventions:
- Return the title, optional aliases, and markdown body in the requested structure.
- Do not repeat the title as a heading in the body.
- Link liberally with [[wiki-links]] (10-15 maximum), including useful concepts that do not have pages yet.
- Use [[target|label]] when the prose needs a label different from the page name.
- Do not link the page to itself.
- Do not invent citations, sources, personal details, or claims absent from the context.
- Prefer concrete prose and useful connections over generic introductory filler.`;

function normalizeFrontmatterValue(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function buildPageMarkdown({
  title,
  aliases,
  body,
}: {
  title: string;
  aliases: string[];
  body: string;
}) {
  const normalizedAliases = [
    ...new Set(aliases.map(normalizeFrontmatterValue).filter(Boolean)),
  ];
  const frontmatter = [
    "---",
    `title: ${normalizeFrontmatterValue(title)}`,
    ...(normalizedAliases.length > 0 ? [`aliases: ${normalizedAliases.join(", ")}`] : []),
    "---",
  ];
  return `${frontmatter.join("\n")}\n${body.trim()}\n`;
}

function extractReferringParagraphs({
  body,
  slug,
  aliases,
}: {
  body: string;
  slug: string;
  aliases: Record<string, string>;
}) {
  return body.split(/\n{2,}/).filter((paragraph) => {
    for (const match of paragraph.matchAll(WIKI_LINK_RE_G)) {
      const target = match[1];
      if (target && resolveSlug(target, aliases) === slug) return true;
    }
    return false;
  });
}

async function buildGenerationPrompt({
  bucket,
  slug,
  index,
}: {
  bucket: R2Bucket;
  slug: string;
  index: WikiIndex;
}) {
  const referringEntries = referringPages(index, slug);
  if (referringEntries.length === 0) return null;

  const referringSources = await Promise.all(
    referringEntries.map(async (entry) => ({
      entry,
      page: await getPage(bucket, entry.slug),
    })),
  );
  const referringContext = referringSources.flatMap(({ entry, page }) => {
    if (!page) return [];
    return extractReferringParagraphs({ body: page.body, slug, aliases: index.aliases }).map(
      (paragraph) => `From ${entry.title} (${entry.slug}):\n${paragraph}`,
    );
  });
  return [
    `Create the missing wiki page at slug "${slug}".`,
    `Existing wiki index (use it to avoid duplicate concepts):\n${JSON.stringify(indexForPrompt(index))}`,
    referringContext.length > 0
      ? `Paragraphs that link to this missing page:\n\n${referringContext.join("\n\n")}`
      : `Pages that link to this target: ${referringEntries.map((entry) => entry.title).join(", ")}.`,
  ].join("\n\n");
}

function createGatewayModel(env: Env) {
  const openai = createOpenAI({
    apiKey: "gateway-byok",
    baseURL: env.OPENAI_BASE_URL,
    headers: gatewayHeaders(env),
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("Authorization");
      return globalThis.fetch(input, { ...init, headers });
    },
  });
  return openai.responses(env.OPENAI_MODEL);
}

type RedLinkUIMessage = UIMessage<unknown, RedLinkStreamDataParts>;

function replayPage(markdown: string) {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream<RedLinkUIMessage>({
      execute: ({ writer }) => {
        writer.write({ type: "data-wiki-page", data: markdown, transient: true });
      },
    }),
    consumeSseStream: consumeStream,
  });
}

export async function createRedLinkGenerationResponse({
  env,
  request,
  slug,
}: {
  env: Env;
  request: Request;
  slug: string;
}) {
  const [existing, index] = await Promise.all([
    getPageRaw(env.WIKI, slug),
    getIndex(env.WIKI),
  ]);
  if (existing !== null) return replayPage(existing);

  const prompt = await buildGenerationPrompt({ bucket: env.WIKI, slug, index });
  if (!prompt) return new Response("Target is not a red link", { status: 409 });

  const stream = createUIMessageStream<RedLinkUIMessage>({
    execute: async ({ writer }) => {
      const result = streamText({
        model: createGatewayModel(env),
        system: SYSTEM_PROMPT,
        prompt,
        output: Output.object({ schema: generatedPageSchema }),
        maxOutputTokens: 16000,
        maxRetries: 2,
        abortSignal: request.signal,
        timeout: 15 * 60 * 1000,
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            store: false,
          } satisfies OpenAIResponsesProviderOptions,
        },
        onError: ({ error }) => {
          console.error(`[red-link/${slug}] generation error:`, error);
        },
      });

      let lastMarkdown: string | null = null;
      let lastWriteAt = 0;
      for await (const partial of result.partialOutputStream) {
        // throttle before building: most per-token snapshots are discarded anyway
        if (Date.now() - lastWriteAt < 250) continue;
        if (!partial.title || !partial.body) continue;
        const markdown = buildPageMarkdown({
          title: partial.title,
          aliases: partial.aliases?.filter((a) => typeof a === "string") ?? [],
          body: partial.body,
        });
        if (markdown === lastMarkdown) continue;

        lastMarkdown = markdown;
        lastWriteAt = Date.now();
        writer.write({ type: "data-wiki-page", data: markdown, transient: true });
      }

      const output = await result.output;
      if (!output) throw new Error("Page generation produced no structured output");

      const markdown = buildPageMarkdown(output);
      await writePage({ bucket: env.WIKI, slug, content: markdown });
      writer.write({ type: "data-wiki-page", data: markdown, transient: true });
    },
    onError: (error) => {
      console.error(`[red-link/${slug}] stream error:`, error);
      return "Page generation failed";
    },
  });

  return createUIMessageStreamResponse({ stream, consumeSseStream: consumeStream });
}
