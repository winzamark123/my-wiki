import { z } from "zod";

const TOKEN_EXPIRY_BUFFER_MS = 60_000;

const luluConfigSchema = z.object({
  baseUrl: z.url(),
  clientKey: z.string().min(1),
  clientSecret: z.string().min(1),
});

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().min(1),
});

export const luluDimensionUnitSchema = z.enum(["pt", "mm", "inch"]);

const dimensionSchema = z
  .union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)])
  .transform(Number)
  .pipe(z.number().positive());

const coverDimensionsSchema = z.object({
  width: dimensionSchema,
  height: dimensionSchema,
  unit: luluDimensionUnitSchema,
});

const pageCountSchema = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().nonnegative())
  .nullish();

const validationBaseSchema = z.object({
  id: z.number().int().positive(),
  source_url: z.url(),
  page_count: pageCountSchema,
  errors: z.array(z.string()).nullish(),
});

const interiorValidationSchema = validationBaseSchema.extend({
  status: z.enum(["NULL", "VALIDATING", "VALIDATED", "NORMALIZING", "NORMALIZED", "ERROR"]),
  valid_pod_package_ids: z.array(z.string()).nullish(),
});

const coverValidationSchema = validationBaseSchema.extend({
  status: z.enum(["NULL", "NORMALIZING", "NORMALIZED", "ERROR"]),
});

const errorResponseSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

function redact({ text, secrets }: { text: string; secrets: string[] }) {
  return secrets.reduce((safe, secret) => (secret ? safe.replaceAll(secret, "[redacted]") : safe), text).slice(0, 500);
}

function parseJson(text: string) {
  try {
    const data: unknown = JSON.parse(text);
    return { data };
  } catch {
    return { data: undefined };
  }
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
  const { data } = parseJson(text);
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(data);
    const details = redact({
      text: error.success ? JSON.stringify(error.data) : text,
      secrets,
    }) || "empty response";
    throw new Error(`lulu ${path} → ${response.status}: ${details}`);
  }
  if (data === undefined) throw new Error(`lulu ${path} → ${response.status}: invalid JSON response`);

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
  now = Date.now,
}: {
  baseUrl: string;
  clientKey: string;
  clientSecret: string;
  now?: () => number;
}) {
  const config = luluConfigSchema.parse({ baseUrl, clientKey, clientSecret });
  const origin = config.baseUrl.replace(/\/+$/, "");
  let token: { value: string; expiresAt: number } | undefined;

  async function getAccessToken() {
    if (token && now() < token.expiresAt - TOKEN_EXPIRY_BUFFER_MS) return token.value;

    const path = "/auth/realms/glasstree/protocol/openid-connect/token";
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${config.clientKey}:${config.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const result = await parseResponse({
      response,
      path,
      schema: tokenSchema,
      secrets: [config.clientKey, config.clientSecret],
    });
    token = {
      value: result.access_token,
      expiresAt: now() + result.expires_in * 1000,
    };
    return token.value;
  }

  async function request<T extends z.ZodType>({
    path,
    method,
    body,
    schema,
  }: {
    path: string;
    method: "GET" | "POST";
    body?: unknown;
    schema: T;
  }) {
    const accessToken = await getAccessToken();
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parseResponse({
      response,
      path,
      schema,
      secrets: [config.clientKey, config.clientSecret, accessToken],
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
      unit: z.infer<typeof luluDimensionUnitSchema>;
    }) {
      return request({
        path: "/cover-dimensions/",
        method: "POST",
        body: {
          pod_package_id: podPackageId,
          interior_page_count: interiorPageCount,
          unit,
        },
        schema: coverDimensionsSchema,
      });
    },

    startInteriorValidation({ sourceUrl, podPackageId }: { sourceUrl: string; podPackageId: string }) {
      return request({
        path: "/validate-interior/",
        method: "POST",
        body: { source_url: sourceUrl, pod_package_id: podPackageId },
        schema: interiorValidationSchema,
      });
    },

    getInteriorValidation({ id }: { id: number }) {
      return request({
        path: `/validate-interior/${id}/`,
        method: "GET",
        schema: interiorValidationSchema,
      });
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
        method: "POST",
        body: {
          source_url: sourceUrl,
          pod_package_id: podPackageId,
          interior_page_count: interiorPageCount,
        },
        schema: coverValidationSchema,
      });
    },

    getCoverValidation({ id }: { id: number }) {
      return request({
        path: `/validate-cover/${id}/`,
        method: "GET",
        schema: coverValidationSchema,
      });
    },
  };
}
