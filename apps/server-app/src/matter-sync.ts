import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { createMatterClient, type MatterItem } from "./matter";
import { sourceMetaFromItem } from "./sources";
import { getSource, getSyncState, writeSource, writeSyncState } from "./source-store";
import { linkSources } from "./links";
import { appendLog, regenerateIndex } from "./wiki-index";

export interface MatterSyncParams {
  // ignore the cursor and walk the whole library
  full?: boolean;
}

// items per step: bounds the step count on a large backfill without one giant step
const BATCH_SIZE = 10;
// markdown endpoint allows 20/min; space fetches inside a step (wall-clock is free)
const MARKDOWN_INTERVAL_MS = 3100;
// sources linked per step: each costs a reranker call and an LLM call
const LINK_BATCH_SIZE = 5;

export class MatterSyncWorkflow extends WorkflowEntrypoint<Env, MatterSyncParams> {
  async run(event: WorkflowEvent<MatterSyncParams>, step: WorkflowStep) {
    const matter = createMatterClient({ token: this.env.MATTER_API_TOKEN });

    const cursor = await step.do("read cursor", async () =>
      event.payload.full ? undefined : (await getSyncState(this.env.WIKI)).cursor,
    );

    // inbox is a follow feed, not a reading list; only queue + archive enter the wiki
    const items = await step.do("list changed items", async () => {
      const list: MatterItem[] = [];
      for await (const item of matter.iterateItems({ status: ["queue", "archive"], updatedSince: cursor })) {
        list.push(item);
      }
      return list;
    });

    let bodiesFetched = 0;
    for (let start = 0; start < items.length; start += BATCH_SIZE) {
      const batch = items.slice(start, start + BATCH_SIZE);
      bodiesFetched += await step.do(`sync items ${start + 1}-${start + batch.length}`, async () => {
        let fetched = 0;
        for (const item of batch) {
          const previous = await getSource(this.env.WIKI, item.id);
          let body = previous?.body ?? "";
          // body is fetched once; Matter re-extractions are rare enough to ignore
          if (!body && item.processing_status === "completed") {
            if (fetched > 0) await new Promise((r) => setTimeout(r, MARKDOWN_INTERVAL_MS));
            body = (await matter.getItemWithMarkdown(item.id)).markdown ?? "";
            fetched++;
          }
          const meta = sourceMetaFromItem({ item, previous: previous?.meta, now: new Date().toISOString() });
          await writeSource({ bucket: this.env.WIKI, meta, body });
        }
        return fetched;
      });
    }

    const pending = await step.do("regenerate index", async () => (await regenerateIndex(this.env.WIKI, this.env.AI)).pending);
    for (let start = 0; start < pending.length; start += LINK_BATCH_SIZE) {
      const batch = pending.slice(start, start + LINK_BATCH_SIZE);
      await step.do(`link items ${start + 1}-${start + batch.length}`, async () => {
        await linkSources({ bucket: this.env.WIKI, ai: this.env.AI, ids: batch });
      });
    }
    if (pending.length > 0) {
      await step.do("regenerate index with links", () => regenerateIndex(this.env.WIKI, this.env.AI).then(() => undefined));
    }

    await step.do("advance cursor", async () => {
      const newest = items.map((i) => i.updated_at).sort().at(-1) ?? cursor;
      await writeSyncState(this.env.WIKI, { cursor: newest, lastRun: new Date().toISOString() });
      await appendLog(
        this.env.WIKI,
        `matter sync: ${items.length} items changed, ${bodiesFetched} bodies fetched, ${pending.length} linked${cursor ? ` since ${cursor}` : " (full)"}`,
      );
    });

    return { items: items.length, bodiesFetched, linked: pending.length };
  }
}
