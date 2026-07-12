import { Marked, type TokenizerAndRendererExtension } from "marked";
import { existingSlugs, resolveSlug, WIKI_LINK_RE, type WikiIndex } from "./wiki";

const ANCHORED_WIKI_LINK = new RegExp(`^${WIKI_LINK_RE.source}`);

// [[Page Name]] / [[target|label]] → internal links; missing targets render as red links
export function renderMarkdown(body: string, index: WikiIndex) {
  const existing = existingSlugs(index);
  const wikiLink: TokenizerAndRendererExtension = {
    name: "wikiLink",
    level: "inline",
    start: (src) => src.indexOf("[["),
    tokenizer(src) {
      const match = src.match(ANCHORED_WIKI_LINK);
      if (!match) return undefined;
      return {
        type: "wikiLink",
        raw: match[0],
        target: match[1],
        label: match[2] ?? match[1],
      };
    },
    renderer(token) {
      const slug = resolveSlug(token.target, index.aliases);
      const red = existing.has(slug) ? "" : " data-red-link";
      return `<a href="/wiki/${slug}" data-wiki-link${red}>${token.label}</a>`;
    },
  };
  return new Marked({ extensions: [wikiLink] }).parse(body, { async: false });
}
