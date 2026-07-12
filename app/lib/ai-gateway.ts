// Cloudflare AI Gateway request headers, shared by both LLM callers (BYOK: the
// gateway injects the real provider key; callers must not send Authorization)
export function gatewayHeaders(env: Env) {
  return {
    "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
    "cf-aig-skip-cache": "true",
    "cf-aig-collect-log-payload": "false",
  };
}
