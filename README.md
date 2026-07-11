# my-wiki

Personal LLM-maintained wiki. See [DESIGN.md](DESIGN.md) for the product spec and [ARCHITECTURE.md](ARCHITECTURE.md) for how it maps onto Cloudflare.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # add a Cloudflare AI Gateway Run token, or use the mock below
bash scripts/seed.sh             # seed the local R2 bucket with sample pages
pnpm dev                         # http://localhost:5173
curl -X POST localhost:5173/api/reindex   # rebuild index.json after seeding
```

Real synthesis calls use GPT-5.6 Terra through the authenticated `my-wiki` AI Gateway. The OpenAI service key is stored as the gateway's `default` BYOK provider key; it is not a Worker secret and does not belong in `.dev.vars`.

### Testing without provider credentials

`scripts/mock-openai.mjs` is a scripted stand-in for the OpenAI Responses API (`read_page` → `write_page` for `tailscale` → final report). It exercises the full pipeline: input box → Workflow → tool loop → write seam → toast.

```sh
node scripts/mock-openai.mjs &   # listens on :8788
```

Use these local values in `.dev.vars`:

```
CF_AIG_TOKEN=mock-token-local-test
OPENAI_BASE_URL=http://localhost:8788
```

The mock resets its script per process. Restart it before another synthesis job.

## Deploy

Requires `wrangler login` on account `e62b5d31403985d71d0a4faae9948728`, an authenticated `my-wiki` AI Gateway with the OpenAI BYOK key stored under alias `default`, and then:

```sh
pnpm exec wrangler r2 bucket create my-wiki   # once
pnpm exec wrangler secret put CF_AIG_TOKEN    # masked prompt; never pass the value as an argument
pnpm run deploy
```

The Worker sends `cf-aig-skip-cache: true` and `cf-aig-collect-log-payload: false` on every synthesis request. AI Gateway retains usage metadata but not wiki prompts or model responses.

`workers_dev` and preview URLs are disabled in `wrangler.jsonc`. The deployment remains unreachable until a custom domain is attached and Cloudflare Access protects write routes.
