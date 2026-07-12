import { DurableObject } from "cloudflare:workers";

type StreamStatus = "idle" | "streaming";

// marks the DO's loopback fetch so the route generates instead of proxying back in
export const INTERNAL_HEADER = "X-Resumable-Internal";
const STREAM_TTL_MS = 2 * 60 * 1000;

function padSequence(value: number) {
  return value.toString().padStart(9, "0");
}

export class ResumableStreamDO extends DurableObject<Env> {
  private sequence = 0;
  private fetching = false;
  private liveWriters = new Set<WritableStreamDefaultWriter>();
  private writerSequences = new WeakMap<WritableStreamDefaultWriter, number>();
  private abortController: AbortController | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.blockConcurrencyWhile(async () => {
      const status = await this.ctx.storage.get<StreamStatus>("status");
      if (status === "streaming") {
        await this.resetStreamState();
        return;
      }
      this.sequence = (await this.ctx.storage.get<number>("sequence")) ?? 0;
    });
  }

  private async resetStreamState() {
    const storedChunks = await this.ctx.storage.list({ prefix: "chunk:" });
    const chunkKeys = [...storedChunks.keys()];
    if (chunkKeys.length > 0) await this.ctx.storage.delete(chunkKeys);
    await Promise.all([
      this.ctx.storage.put<StreamStatus>("status", "idle"),
      this.ctx.storage.delete("sequence"),
      this.ctx.storage.delete("headers"),
    ]);
    this.sequence = 0;
  }

  private closeWriter(writer: WritableStreamDefaultWriter) {
    writer.close().catch(() => undefined);
  }

  private async abortStream() {
    const aborted = await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.fetching) return false;
      this.abortController?.abort();
      return true;
    });
    return new Response(null, { status: aborted ? 200 : 204 });
  }

  async fetch(request: Request) {
    await this.ctx.storage.setAlarm(Date.now() + STREAM_TTL_MS);

    let headers: Record<string, string> | undefined;
    if (request.method === "POST") {
      const upstreamError = await this.ctx.blockConcurrencyWhile(async () => {
        if (this.fetching) return null;

        const internalHeaders = new Headers(request.headers);
        internalHeaders.set(INTERNAL_HEADER, "1");
        const upstreamRequest = new Request(request, { headers: internalHeaders });
        this.abortController = new AbortController();
        const response = await fetch(upstreamRequest, {
          signal: this.abortController.signal,
        });
        if (!response.ok) {
          this.abortController = null;
          return response;
        }
        if (!response.body) {
          this.abortController = null;
          return new Response("Missing stream body", { status: 502 });
        }

        this.fetching = true;
        headers = Object.fromEntries(response.headers);
        await Promise.all([
          this.ctx.storage.put<StreamStatus>("status", "streaming"),
          this.ctx.storage.put("headers", headers),
        ]);
        this.ctx.waitUntil(this.pipeUpstream(response));
        return undefined;
      });
      if (upstreamError) return upstreamError;
    } else if (request.method === "DELETE") {
      return this.abortStream();
    }

    headers ??= await this.ctx.storage.get<Record<string, string>>("headers");
    if (!headers) return new Response(null, { status: 204 });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    let replayEndSequence = 0;
    await this.ctx.blockConcurrencyWhile(async () => {
      // list() returns keys in ascending order and chunk keys are zero-padded
      const storedChunks = await this.ctx.storage.list<Uint8Array>({ prefix: "chunk:" });
      for (const value of storedChunks.values()) {
        writer.write(value).catch(() => undefined);
      }
      replayEndSequence = storedChunks.size;
    });

    if (!this.fetching) {
      this.closeWriter(writer);
    } else {
      this.writerSequences.set(writer, replayEndSequence);
      await this.backfillGaps({ writer, startSequence: replayEndSequence });
      if (this.fetching) {
        this.liveWriters.add(writer);
      } else {
        this.closeWriter(writer);
      }
    }

    const responseHeaders = new Headers(headers);
    responseHeaders.set("Cache-Control", "no-store");
    if (!this.fetching) return new Response(readable, { headers: responseHeaders });

    const [clientStream, drainStream] = readable.tee();
    drainStream
      .pipeTo(new WritableStream())
      .catch(() => undefined)
      .finally(() => this.liveWriters.delete(writer));
    writer.closed.catch(() => {
      this.liveWriters.delete(writer);
      this.writerSequences.delete(writer);
    });

    return new Response(clientStream, { headers: responseHeaders });
  }

  private async pipeUpstream(response: Response) {
    const body = response.body;
    if (!body) return;

    try {
      const reader = body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const key = `chunk:${padSequence(this.sequence)}`;
        const nextSequence = this.sequence + 1;
        await this.ctx.storage.put({ [key]: value, sequence: nextSequence });
        this.sequence = nextSequence;

        for (const writer of this.liveWriters) {
          const nextExpected = this.writerSequences.get(writer) ?? 0;
          if (nextExpected >= this.sequence) continue;
          const sequence = this.sequence;
          writer
            .write(value)
            .then(() => this.writerSequences.set(writer, sequence))
            .catch(() => undefined);
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        console.error("[resumable-stream] upstream error:", error);
      }
    } finally {
      this.fetching = false;
      this.abortController = null;
      for (const writer of this.liveWriters) this.closeWriter(writer);
      this.liveWriters.clear();
      await this.resetStreamState();
    }
  }

  private async backfillGaps({
    writer,
    startSequence,
  }: {
    writer: WritableStreamDefaultWriter;
    startSequence: number;
  }) {
    let cursor = startSequence;
    while (cursor < this.sequence) {
      const currentSequence = this.sequence;
      const chunks = await this.ctx.storage.list<Uint8Array>({
        prefix: "chunk:",
        start: `chunk:${padSequence(cursor)}`,
        end: `chunk:${padSequence(currentSequence)}`,
      });

      for (const [key, chunk] of chunks) {
        const chunkSequence = Number.parseInt(key.slice("chunk:".length), 10);
        const nextExpected = this.writerSequences.get(writer) ?? 0;
        if (chunkSequence < nextExpected) continue;
        try {
          await writer.write(chunk);
          this.writerSequences.set(writer, chunkSequence + 1);
        } catch {
          return;
        }
      }
      cursor = currentSequence;
    }
  }

  async alarm() {
    if (this.fetching) {
      await this.ctx.storage.setAlarm(Date.now() + STREAM_TTL_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.sequence = 0;
    this.liveWriters.clear();
  }
}
