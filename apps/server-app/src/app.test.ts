import { describe, expect, it, vi } from "vitest";

import { app } from "./app";
import { bookCreateResponseSchema } from "./books";

describe("server app", () => {
  it("reports its health", async () => {
    const response = await app.request("http://localhost/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns JSON for unknown routes", async () => {
    const response = await app.request("http://localhost/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });

  it("starts a book workflow with a stable source cutoff", async () => {
    const create = vi.fn(async ({ id }: { id: string }) => ({ id }));
    // worker bindings are runtime-provided; this route only reads these two bindings.
    const env = { BOOK: { create }, FRONTEND_URL: "http://localhost:5173" } as unknown as Env;
    const response = await app.request("http://localhost/api/book", { method: "POST" }, env);

    expect(response.status).toBe(202);
    const body = bookCreateResponseSchema.parse(await response.json());
    expect(body).toEqual({
      id: expect.stringMatching(/^book-/),
      source_cutoff: expect.any(String),
    });
    expect(create).toHaveBeenCalledWith({ id: body.id, params: { source_cutoff: body.source_cutoff } });
  });
});
