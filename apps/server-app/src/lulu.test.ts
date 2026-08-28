import { afterEach, describe, expect, it, vi } from "vitest";

import { createLuluClient, luluDimensionUnitSchema } from "./lulu";

const BASE_URL = "https://api.sandbox.lulu.com";
const POD_PACKAGE_ID = "0850X1100.FC.PRE.PB.080CW444.MXX";
const DIMENSION_UNIT = luluDimensionUnitSchema.enum.pt;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createClient(now?: () => number) {
  return createLuluClient({
    baseUrl: BASE_URL,
    clientKey: "sandbox-key",
    clientSecret: "sandbox-secret",
    now,
  });
}

const tokenResponse = {
  access_token: "access-token",
  expires_in: 3600,
  token_type: "bearer",
};

describe("createLuluClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates with client credentials and reuses the token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/token")) return jsonResponse(tokenResponse);
      return jsonResponse({ width: "1263.000", height: "810.000", unit: "pt" }, { status: 201 });
    });

    const client = createClient();
    const input = { podPackageId: POD_PACKAGE_ID, interiorPageCount: 100, unit: DIMENSION_UNIT };
    await expect(client.calculateCoverDimensions(input)).resolves.toEqual({
      width: 1263,
      height: 810,
      unit: "pt",
    });
    await client.calculateCoverDimensions(input);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      url: `${BASE_URL}/auth/realms/glasstree/protocol/openid-connect/token`,
      init: {
        method: "POST",
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      },
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
    let currentTime = 0;
    let tokenRequests = 0;
    vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
      if (String(input).endsWith("/token")) {
        tokenRequests++;
        return jsonResponse({ ...tokenResponse, access_token: `access-token-${tokenRequests}`, expires_in: 120 });
      }
      return jsonResponse({ width: "1263.000", height: "810.000", unit: "pt" }, { status: 201 });
    });

    const client = createClient(() => currentTime);
    const input = { podPackageId: POD_PACKAGE_ID, interiorPageCount: 100, unit: DIMENSION_UNIT };
    await client.calculateCoverDimensions(input);
    currentTime = 61_000;
    await client.calculateCoverDimensions(input);

    expect(tokenRequests).toBe(2);
  });

  it("starts and retrieves interior and cover validations", async () => {
    const apiCalls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/token")) return jsonResponse(tokenResponse);
      apiCalls.push({ url, init });
      if (url.endsWith("/validate-interior/")) {
        return jsonResponse(
          {
            id: 11,
            source_url: "https://files.example/interior.pdf",
            page_count: null,
            errors: null,
            status: "NORMALIZING",
            valid_pod_package_ids: null,
          },
          { status: 201 },
        );
      }
      if (url.endsWith("/validate-interior/11/")) {
        return jsonResponse({
          id: 11,
          source_url: "https://files.example/interior.pdf",
          page_count: "100",
          errors: null,
          status: "NORMALIZED",
          valid_pod_package_ids: [POD_PACKAGE_ID],
        });
      }
      if (url.endsWith("/validate-cover/")) {
        return jsonResponse(
          {
            id: 12,
            source_url: "https://files.example/cover.pdf",
            page_count: 1,
            errors: null,
            status: "NORMALIZING",
          },
          { status: 201 },
        );
      }
      return jsonResponse({
        id: 12,
        source_url: "https://files.example/cover.pdf",
        page_count: 1,
        errors: null,
        status: "NORMALIZED",
      });
    });

    const client = createClient();
    await expect(
      client.startInteriorValidation({
        sourceUrl: "https://files.example/interior.pdf",
        podPackageId: POD_PACKAGE_ID,
      }),
    ).resolves.toMatchObject({ id: 11, status: "NORMALIZING" });
    await expect(client.getInteriorValidation({ id: 11 })).resolves.toMatchObject({
      id: 11,
      page_count: 100,
      status: "NORMALIZED",
    });
    await expect(
      client.startCoverValidation({
        sourceUrl: "https://files.example/cover.pdf",
        podPackageId: POD_PACKAGE_ID,
        interiorPageCount: 100,
      }),
    ).resolves.toMatchObject({ id: 12, status: "NORMALIZING" });
    await expect(client.getCoverValidation({ id: 12 })).resolves.toMatchObject({
      id: 12,
      status: "NORMALIZED",
    });

    expect(apiCalls.map(({ url }) => url)).toEqual([
      `${BASE_URL}/validate-interior/`,
      `${BASE_URL}/validate-interior/11/`,
      `${BASE_URL}/validate-cover/`,
      `${BASE_URL}/validate-cover/12/`,
    ]);
    expect(JSON.parse(String(apiCalls[0].init?.body))).toEqual({
      source_url: "https://files.example/interior.pdf",
      pod_package_id: POD_PACKAGE_ID,
    });
    expect(JSON.parse(String(apiCalls[2].init?.body))).toEqual({
      source_url: "https://files.example/cover.pdf",
      pod_package_id: POD_PACKAGE_ID,
      interior_page_count: 100,
    });
  });

  it("rejects invalid OAuth responses", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ expires_in: 3600, token_type: "bearer" }));

    await expect(
      createClient().calculateCoverDimensions({
        podPackageId: POD_PACKAGE_ID,
        interiorPageCount: 100,
        unit: "pt",
      }),
    ).rejects.toThrow("invalid response");
  });

  it("rejects invalid successful API responses", async () => {
    vi.stubGlobal("fetch", async (input: URL | RequestInfo) =>
      String(input).endsWith("/token")
        ? jsonResponse(tokenResponse)
        : jsonResponse({ width: "not-a-number", height: "810.000", unit: "pt" }, { status: 201 }),
    );

    await expect(
      createClient().calculateCoverDimensions({
        podPackageId: POD_PACKAGE_ID,
        interiorPageCount: 100,
        unit: "pt",
      }),
    ).rejects.toThrow("invalid response");
  });

  it("includes Lulu response details in API errors without exposing credentials", async () => {
    vi.stubGlobal("fetch", async (input: URL | RequestInfo) =>
      String(input).endsWith("/token")
        ? jsonResponse(tokenResponse)
        : jsonResponse(
            { error: `invalid sandbox-key sandbox-secret access-token package` },
            { status: 400 },
          ),
    );

    const pending = createClient().calculateCoverDimensions({
      podPackageId: POD_PACKAGE_ID,
      interiorPageCount: 100,
      unit: "pt",
    });
    await expect(pending).rejects.toThrow("400");
    await expect(pending).rejects.toThrow("invalid [redacted] [redacted] [redacted] package");
  });
});
