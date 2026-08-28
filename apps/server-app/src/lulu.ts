// Lulu Print API client. see ARCHITECTURE.md → External APIs → Lulu
import { z } from "zod";

const TOKEN_PATH = "/auth/realms/glasstree/protocol/openid-connect/token";
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const dimensionUnitSchema = z.enum(["pt", "mm", "inch"]);

// lulu returns numbers as strings, e.g. "1263.000"
const coverDimensionsSchema = z.object({
  width: z.coerce.number().positive(),
  height: z.coerce.number().positive(),
  unit: dimensionUnitSchema,
});

const validationBaseSchema = z.object({
  id: z.number().int().positive(),
  source_url: z.url(),
  page_count: z.coerce.number().int().nonnegative().nullish(),
  errors: z.array(z.string()).nullish(),
});

const interiorValidationSchema = validationBaseSchema.extend({
  status: z.enum(["NULL", "VALIDATING", "VALIDATED", "NORMALIZING", "NORMALIZED", "ERROR"]),
  valid_pod_package_ids: z.array(z.string()).nullish(),
});

const coverValidationSchema = validationBaseSchema.extend({
  status: z.enum(["NULL", "NORMALIZING", "NORMALIZED", "ERROR"]),
});

function redact({ text, secrets }: { text: string; secrets: string[] }) {
  return secrets.reduce((safe, secret) => (secret ? safe.replaceAll(secret, "[redacted]") : safe), text).slice(0, 500);
}

async function parseResponse<T extends z.ZodType>({
  response,
  path,
  schema,
  secrets,
}: {
  response: Response;
  path: string;
  schema: T;
  secrets: string[];
}) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`lulu ${path} → ${response.status}: ${redact({ text, secrets }) || "empty response"}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`lulu ${path} → ${response.status}: invalid JSON response`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`lulu ${path} → ${response.status}: invalid response: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function createLuluClient({
  baseUrl,
  clientKey,
  clientSecret,
}: {
  baseUrl: string;
  clientKey: string;
  clientSecret: string;
}) {
  // cached as a promise so concurrent callers share one token request
  let token: Promise<{ value: string; expiresAt: number }> | undefined;

  async function fetchToken() {
    const response = await fetch(`${baseUrl}${TOKEN_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${clientKey}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const result = await parseResponse({
      response,
      path: TOKEN_PATH,
      schema: tokenSchema,
      secrets: [clientKey, clientSecret],
    });
    return { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  }

  async function getAccessToken() {
    const cached = token && (await token);
    if (cached && Date.now() < cached.expiresAt - TOKEN_EXPIRY_BUFFER_MS) return cached.value;

    token = fetchToken().catch((error: unknown) => {
      token = undefined;
      throw error;
    });
    return (await token).value;
  }

  async function request<T extends z.ZodType>({ path, body, schema }: { path: string; body?: unknown; schema: T }) {
    const accessToken = await getAccessToken();
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parseResponse({
      response,
      path,
      schema,
      secrets: [clientKey, clientSecret, accessToken],
    });
  }

  return {
    calculateCoverDimensions({
      podPackageId,
      interiorPageCount,
      unit,
    }: {
      podPackageId: string;
      interiorPageCount: number;
      unit: z.infer<typeof dimensionUnitSchema>;
    }) {
      return request({
        path: "/cover-dimensions/",
        body: { pod_package_id: podPackageId, interior_page_count: interiorPageCount, unit },
        schema: coverDimensionsSchema,
      });
    },

    startInteriorValidation({ sourceUrl, podPackageId }: { sourceUrl: string; podPackageId: string }) {
      return request({
        path: "/validate-interior/",
        body: { source_url: sourceUrl, pod_package_id: podPackageId },
        schema: interiorValidationSchema,
      });
    },

    getInteriorValidation({ id }: { id: number }) {
      return request({ path: `/validate-interior/${id}/`, schema: interiorValidationSchema });
    },

    startCoverValidation({
      sourceUrl,
      podPackageId,
      interiorPageCount,
    }: {
      sourceUrl: string;
      podPackageId: string;
      interiorPageCount: number;
    }) {
      return request({
        path: "/validate-cover/",
        body: { source_url: sourceUrl, pod_package_id: podPackageId, interior_page_count: interiorPageCount },
        schema: coverValidationSchema,
      });
    },

    getCoverValidation({ id }: { id: number }) {
      return request({ path: `/validate-cover/${id}/`, schema: coverValidationSchema });
    },
  };
}
