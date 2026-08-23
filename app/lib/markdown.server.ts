import { Marked } from "marked";

// source bodies are Matter's CommonMark
export function renderMarkdown(body: string) {
  return new Marked().parse(body, { async: false });
}
