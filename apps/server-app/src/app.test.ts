import { describe, expect, it } from "vitest";

import { app } from "./app";

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
});
