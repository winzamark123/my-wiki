import type { z } from "zod";

// shared by link labeling and book planning; changing it changes every generated label and title
export const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// text-generation models wrap their output in `response`, and JSON mode may still return it as a string
export function parseModelJson<T extends z.ZodType>({ result, schema }: { result: unknown; schema: T }) {
  const response = typeof result === "object" && result !== null && "response" in result ? result.response : result;
  return schema.parse(typeof response === "string" ? JSON.parse(response) : response);
}
