import { afterEach, describe, expect, it, vi } from "vitest";

import { createLuluClient } from "./lulu";

const BASE_URL = "https://api.sandbox.lulu.com";
const POD_PACKAGE_ID = "0850X1100.FC.PRE.PB.080CW444.MXX";

const tokenResponse = { access_token: "access-token", expires_in: 3600, token_type: "bearer" };
const coverDimensionsResponse = { width: "1263.000", height: "810.000", unit: "pt" };
const coverInput = { podPackageId: POD_PACKAGE_ID, interiorPageCount: 100, unit: "pt" as const };

const interiorValidation = { id: 11, source_url: "https://files.example/interior.pdf", status: "NORMALIZING" };
const coverValidation = { id: 12, source_url: "https://files.example/cover.pdf", page_count: 1, status: "NORMALIZING" };

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

// answers the token route, delegates every api call to `handler`
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    return url.endsWith("/token") ? jsonResponse(tokenResponse) : handler(url, init);
  });
}

function createClient() {
  return createLuluClient({ baseUrl: BASE_URL, clientKey: "sandbox-key", clientSecret: "sandbox-secret" });
}

describe("createLuluClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("authenticates with client credentials and shares the token across calls", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return url.endsWith("/token")
        ? jsonResponse(tokenResponse)
        : jsonResponse(coverDimensionsResponse, { status: 201 });
    });

    const client = createClient();
    const [first] = await Promise.all([
      client.calculateCoverDimensions(coverInput),
      client.calculateCoverDimensions(coverInput),
    ]);
    await client.calculateCoverDimensions(coverInput);

    expect(first).toEqual({ width: 1263, height: 810, unit: "pt" });
    expect(calls.map(({ url }) => url)).toEqual([
      `${BASE_URL}/auth/realms/glasstree/protocol/openid-connect/token`,
      `${BASE_URL}/cover-dimensions/`,
      `${BASE_URL}/cover-dimensions/`,
      `${BASE_URL}/cover-dimensions/`,
    ]);
    expect(calls[0].init).toMatchObject({
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe(
      `Basic ${btoa("sandbox-key:sandbox-secret")}`,
    );
    expect(new Headers(calls[1].init?.headers).get("Authorization")).toBe("Bearer access-token");
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      pod_package_id: POD_PACKAGE_ID,
      interior_page_count: 100,
      unit: "pt",
    });
  });

  it("refreshes the token shortly before it expires", async () => {
    vi.useFakeTimers();
    let tokenRequests = 0;
    vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
      if (String(input).endsWith("/token")) {
        tokenRequests++;
        return jsonResponse({ ...tokenResponse, expires_in: 120 });
      }
      return jsonResponse(coverDimensionsResponse, { status: 201 });
    });

    const client = createClient();
    await client.calculateCoverDimensions(coverInput);
    vi.advanceTimersByTime(61_000);
    await client.calculateCoverDimensions(coverInput);

    expect(tokenRequests).toBe(2);
  });

  it("starts and retrieves interior and cover validations", async () => {
    const apiCalls: { url: string; init?: RequestInit }[] = [];
    stubFetch((url, init) => {
      apiCalls.push({ url, init });
      if (url.endsWith("/validate-interior/")) return jsonResponse(interiorValidation, { status: 201 });
      if (url.endsWith("/validate-interior/11/")) {
        return jsonResponse({
          ...interiorValidation,
          page_count: "100",
          status: "NORMALIZED",
          valid_pod_package_ids: [POD_PACKAGE_ID],
        });
      }
      if (url.endsWith("/validate-cover/")) return jsonResponse(coverValidation, { status: 201 });
      return jsonResponse({ ...coverValidation, status: "NORMALIZED" });
    });

    const client = createClient();
    await expect(
      client.startInteriorValidation({ sourceUrl: interiorValidation.source_url, podPackageId: POD_PACKAGE_ID }),
    ).resolves.toMatchObject({ id: 11, status: "NORMALIZING" });
    await expect(client.getInteriorValidation({ id: 11 })).resolves.toMatchObject({
      id: 11,
      page_count: 100,
      status: "NORMALIZED",
    });
    await expect(
      client.startCoverValidation({
        sourceUrl: coverValidation.source_url,
        podPackageId: POD_PACKAGE_ID,
        interiorPageCount: 100,
      }),
    ).resolves.toMatchObject({ id: 12, status: "NORMALIZING" });
    await expect(client.getCoverValidation({ id: 12 })).resolves.toMatchObject({ id: 12, status: "NORMALIZED" });

    expect(apiCalls.map(({ url }) => url)).toEqual([
      `${BASE_URL}/validate-interior/`,
      `${BASE_URL}/validate-interior/11/`,
      `${BASE_URL}/validate-cover/`,
      `${BASE_URL}/validate-cover/12/`,
    ]);
    expect(JSON.parse(String(apiCalls[0].init?.body))).toEqual({
      source_url: interiorValidation.source_url,
      pod_package_id: POD_PACKAGE_ID,
    });
    expect(JSON.parse(String(apiCalls[2].init?.body))).toEqual({
      source_url: coverValidation.source_url,
      pod_package_id: POD_PACKAGE_ID,
      interior_page_count: 100,
    });
  });

  it("rejects invalid OAuth responses", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ expires_in: 3600, token_type: "bearer" }));

    await expect(createClient().calculateCoverDimensions(coverInput)).rejects.toThrow("invalid response");
  });

  it("rejects invalid successful API responses", async () => {
    stubFetch(() => jsonResponse({ ...coverDimensionsResponse, width: "not-a-number" }, { status: 201 }));

    await expect(createClient().calculateCoverDimensions(coverInput)).rejects.toThrow("invalid response");
  });

  it("includes Lulu response details in API errors without exposing credentials", async () => {
    stubFetch(() =>
      jsonResponse({ error: "invalid sandbox-key sandbox-secret access-token package" }, { status: 400 }),
    );

    await expect(createClient().calculateCoverDimensions(coverInput)).rejects.toThrow(
      /400.*invalid \[redacted\] \[redacted\] \[redacted\] package/,
    );
  });
});
