import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInput,
} from "openai/resources/responses/responses";
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

const TOOLS = [
  {
    type: "function",
    name: "read_page",
    description:
      "Read a wiki page's raw markdown (including frontmatter) by slug. Returns 'not found' if it doesn't exist.",
    parameters: z.toJSONSchema(readPageInput),
    strict: true,
  },
  {
    type: "function",
    name: "write_page",
    description:
      "Create or replace a wiki page. Content must be complete markdown including frontmatter (title, optional aliases).",
    parameters: z.toJSONSchema(writePageInput),
    strict: true,
  },
] satisfies FunctionTool[];

const statusSchema = z.enum(["completed", "failed", "in_progress", "cancelled", "queued", "incomplete"]);
const itemStatusSchema = z.enum(["in_progress", "completed", "incomplete"]);
const callerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("direct") }),
  z.object({ type: z.literal("program"), caller_id: z.string() }),
]);
const responseOutputSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("reasoning"),
    summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })),
    content: z.array(z.object({ type: z.literal("reasoning_text"), text: z.string() })).optional(),
    encrypted_content: z.string().nullable().optional(),
    status: itemStatusSchema.optional(),
  }),
  z.object({
    id: z.string().optional(),
    type: z.literal("function_call"),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
    caller: callerSchema.nullable().optional(),
    namespace: z.string().optional(),
    status: itemStatusSchema.optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("message"),
    role: z.literal("assistant"),
    status: itemStatusSchema,
    phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
    content: z.array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("output_text"),
          text: z.string(),
          annotations: z.array(z.never()),
        }),
        z.object({ type: z.literal("refusal"), refusal: z.string() }),
      ]),
    ),
  }),
]);
const responseSchema = z.object({
  status: statusSchema,
  output: z.array(responseOutputSchema),
  outputText: z.string(),
});

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

    const input: ResponseInput = [
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

    const client = new OpenAI({
      apiKey: this.env.CF_AIG_TOKEN,
      baseURL: this.env.OPENAI_BASE_URL,
      maxRetries: 0,
      defaultHeaders: {
        Authorization: null,
        "cf-aig-authorization": `Bearer ${this.env.CF_AIG_TOKEN}`,
        "cf-aig-skip-cache": "true",
        "cf-aig-collect-log-payload": "false",
      },
    });
    const written: string[] = [];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // JSON round-trip because step results must satisfy Workflows' Serializable type
      const responseJson = await step.do(`llm turn ${turn}`, async () => {
        const result = await client.responses.create({
          model: this.env.OPENAI_MODEL,
          instructions: SYSTEM_PROMPT,
          input,
          tools: TOOLS,
          max_output_tokens: 16000,
          reasoning: { effort: "high" },
          store: false,
          include: ["reasoning.encrypted_content"],
        });
        return JSON.stringify({
          status: result.status ?? "completed",
          output: result.output,
          outputText: result.output_text,
        });
      });
      const response = responseSchema.parse(JSON.parse(responseJson));

      if (response.status !== "completed") {
        throw new Error(`OpenAI response ended with status ${response.status}`);
      }

      input.push(...response.output);
      const toolCalls = response.output.filter((item) => item.type === "function_call");

      if (toolCalls.length === 0) {
        const report = response.outputText || "Synthesis completed without a report.";
        await step.do("log", () =>
          appendLog(this.env.WIKI, `synthesis: ${report.slice(0, 300)}`),
        );
        return { written, report };
      }

      for (const call of toolCalls) {
        const output = await this.runTool(call, step, turn, written);
        input.push({
          type: "function_call_output",
          call_id: call.call_id,
          output,
          ...(call.caller ? { caller: call.caller } : {}),
        });
      }
    }

    await step.do("log max turns", () =>
      appendLog(this.env.WIKI, `synthesis hit MAX_TURNS (${MAX_TURNS}) — written so far: ${written.join(", ") || "none"}`),
    );
    return { written, report: `stopped after ${MAX_TURNS} turns` };
  }

  private async runTool(
    call: ResponseFunctionToolCall,
    step: WorkflowStep,
    turn: number,
    written: string[],
  ) {
    const parsedArguments = parseJson(call.arguments);
    if (!parsedArguments.success) return `invalid JSON input: ${parsedArguments.error}`;

    if (call.name === "read_page") {
      const input = readPageInput.safeParse(parsedArguments.data);
      if (!input.success) return `invalid input: ${input.error.message}`;
      const slug = slugify(input.data.slug);
      return step.do(`read ${slug} (turn ${turn}, ${call.call_id})`, async () => {
        const obj = await this.env.WIKI.get(`wiki/${slug}.md`);
        return obj ? await obj.text() : "not found";
      });
    }

    if (call.name === "write_page") {
      const input = writePageInput.safeParse(parsedArguments.data);
      if (!input.success) return `invalid input: ${input.error.message}`;
      const slug = slugify(input.data.slug);
      const output = await step.do(`write ${slug} (turn ${turn}, ${call.call_id})`, async () => {
        await writePage({ bucket: this.env.WIKI, slug, content: input.data.content });
        return `wrote ${slug}`;
      });
      if (!written.includes(slug)) written.push(slug);
      return output;
    }

    return `unknown tool: ${call.name}`;
  }
}

function parseJson(value: string) {
  try {
    const data: unknown = JSON.parse(value);
    return { success: true as const, data };
  } catch (error) {
    return {
      success: false as const,
      error: error instanceof Error ? error.message : "unknown JSON parse error",
    };
  }
}
