# my-wiki

A graph of everything I read in Matter, synthesized into topic pages by an LLM, printable as a book. See [DESIGN.md](DESIGN.md) for the product spec and [ARCHITECTURE.md](ARCHITECTURE.md) for how it maps onto Cloudflare.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # AI Gateway Run token + Matter API token
pnpm dev                         # http://localhost:5173
curl -X POST "localhost:5173/api/sync?full=1"   # pull the Matter queue + archive into the local bucket
curl "localhost:5173/api/sync?id=<instance id>"  # sync status
curl -X POST localhost:5173/api/reindex         # rebuild index.json + embeddings by hand
pnpm test                        # unit tests for the pure modules (vitest)
pnpm typecheck
```

Workers AI (embeddings) always runs remotely, even in dev, so `wrangler login` must be on account `e62b5d31403985d71d0a4faae9948728`. `wrangler r2 object …` commands default to the local store; pass `--remote` for the real bucket.

Synthesis calls use GPT-5.6 Sol with high reasoning through the authenticated `my-wiki` AI Gateway. The OpenAI service key is stored as the gateway's `default` BYOK provider key; it is not a Worker secret and does not belong in `.dev.vars`.

## Deploy

Requires `wrangler login` on the account above, an authenticated `my-wiki` AI Gateway with the OpenAI BYOK key stored under alias `default`, and then:

```sh
pnpm exec wrangler r2 bucket create my-wiki     # once
pnpm exec wrangler secret put CF_AIG_TOKEN      # masked prompt; never pass the value as an argument
pnpm exec wrangler secret put MATTER_API_TOKEN
pnpm run deploy
```

The Worker sends `cf-aig-skip-cache: true` and `cf-aig-collect-log-payload: false` on every synthesis request. AI Gateway retains usage metadata but not wiki prompts or model responses.

`workers_dev` and preview URLs are disabled in `wrangler.jsonc`. The deployment remains unreachable until a custom domain is attached; private routes (`/source/*`, `/book*`, `/api/*`) are then gated by Cloudflare Access with One-time PIN.
