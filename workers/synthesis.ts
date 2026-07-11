import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { appendLog, getIndex, getPage, slugify, writePage } from "../app/lib/wiki.server";

export interface SynthesisParams {
  text: string;
  contextSlug?: string;
}

export interface SynthesisResult {
  written: string[];
  report: string;
}

const MAX_TURNS = 12;

const SYSTEM_PROMPT = `You are the maintainer of a personal wiki. All content is markdown. You synthesize the user's inputs into durable, well-written wiki pages.

Conventions:
- Pages are blog-style articles: narrative, readable prose — not terse notes. Write in a voice the owner enjoys reading.
- Link liberally with [[wiki-links]] (10-15 per page max), including to pages that don't exist yet. Red links are a feature: they mark the curiosity frontier.
- Before creating a link or page, check the index for an existing page or alias that covers the concept. Never fragment the graph with near-duplicates.
- Never blind-append. Weave new information into the page where it belongs; restructure if needed. Pages are synthesis, not journals.
- The user's input may belong on the current page, another page, or a new page — you decide placement.
- Every page starts with frontmatter: --- title: ... aliases: comma, separated (optional) ---
- Slugs are kebab-case.

You have tools to read and write pages. When done, reply with a short plain-text report of what you did: which pages you created or updated and why.`;

const readPageInput = z.object({
  slug: z.string().describe("kebab-case page slug"),
});
const writePageInput = z.object({
  slug: z.string().describe("kebab-case page slug"),
  content: z.string().describe("full markdown content with frontmatter"),
});

// cast: z.toJSONSchema emits a plain JSON schema object, typed more broadly than the SDK's InputSchema
const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_page",
    description:
      "Read a wiki page's raw markdown (including frontmatter) by slug. Returns 'not found' if it doesn't exist.",
    input_schema: z.toJSONSchema(readPageInput) as Anthropic.Tool.InputSchema,
  },
  {
    name: "write_page",
    description:
      "Create or replace a wiki page. Content must be complete markdown including frontmatter (title, optional aliases).",
    input_schema: z.toJSONSchema(writePageInput) as Anthropic.Tool.InputSchema,
  },
];

export class SynthesisWorkflow extends WorkflowEntrypoint<Env, SynthesisParams> {
  async run(event: WorkflowEvent<SynthesisParams>, step: WorkflowStep) {
    const { text, contextSlug } = event.payload;

    const context = await step.do("read index", async () => {
      const [index, currentPage] = await Promise.all([
        getIndex(this.env.WIKI),
        contextSlug ? getPage(this.env.WIKI, contextSlug) : null,
      ]);
      return {
        index: JSON.stringify(index.pages.map(({ slug, title, summary }) => ({ slug, title, summary }))),
        aliases: JSON.stringify(index.aliases),
        currentPage: currentPage ? `# ${currentPage.title} (${currentPage.slug})\n\n${currentPage.body}` : null,
      };
    });

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          `Wiki index (all existing pages):\n${context.index}`,
          `Aliases:\n${context.aliases}`,
          context.currentPage
            ? `The user is currently viewing this page (default context, but you decide placement):\n\n${context.currentPage}`
            : "The user is on the wiki index page.",
          `User input:\n${text}`,
        ].join("\n\n"),
      },
    ];

    const client = new Anthropic({
      apiKey: this.env.ANTHROPIC_API_KEY,
      baseURL: this.env.ANTHROPIC_BASE_URL,
    });
    const written: string[] = [];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // JSON round-trip because step results must satisfy Workflows' Serializable type
      const responseJson = await step.do(`llm turn ${turn}`, async () => {
        const result = await client.messages.create({
          model: this.env.ANTHROPIC_MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
        });
        return JSON.stringify({ content: result.content, stop_reason: result.stop_reason });
      });
      const response: Pick<Anthropic.Message, "content" | "stop_reason"> = JSON.parse(responseJson);

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        const report = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        await step.do("log", () =>
          appendLog(this.env.WIKI, `synthesis: ${report.slice(0, 300)}`),
        );
        return { written, report };
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          ...(await this.runTool(block, step, turn, written)),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    await step.do("log max turns", () =>
      appendLog(this.env.WIKI, `synthesis hit MAX_TURNS (${MAX_TURNS}) — written so far: ${written.join(", ") || "none"}`),
    );
    return { written, report: `stopped after ${MAX_TURNS} turns` };
  }

  private async runTool(
    block: Anthropic.ToolUseBlock,
    step: WorkflowStep,
    turn: number,
    written: string[],
  ): Promise<{ content: string; is_error?: boolean }> {
    if (block.name === "read_page") {
      const input = readPageInput.safeParse(block.input);
      if (!input.success) return { content: `invalid input: ${input.error.message}`, is_error: true };
      const slug = slugify(input.data.slug);
      const content = await step.do(`read ${slug} (turn ${turn}, ${block.id})`, async () => {
        const obj = await this.env.WIKI.get(`wiki/${slug}.md`);
        return obj ? await obj.text() : "not found";
      });
      return { content };
    }

    if (block.name === "write_page") {
      const input = writePageInput.safeParse(block.input);
      if (!input.success) return { content: `invalid input: ${input.error.message}`, is_error: true };
      const slug = slugify(input.data.slug);
      const content = await step.do(`write ${slug} (turn ${turn}, ${block.id})`, async () => {
        await writePage({ bucket: this.env.WIKI, slug, content: input.data.content });
        return `wrote ${slug}`;
      });
      if (!written.includes(slug)) written.push(slug);
      return { content };
    }

    return { content: `unknown tool: ${block.name}`, is_error: true };
  }
}
