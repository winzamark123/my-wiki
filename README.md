# my-wiki

Personal LLM-maintained wiki. See [DESIGN.md](DESIGN.md) for the product spec and [ARCHITECTURE.md](ARCHITECTURE.md) for how it maps onto Cloudflare.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # put a real ANTHROPIC_API_KEY here, or use the mock (below)
bash scripts/seed.sh             # seed the local R2 bucket with sample pages
pnpm dev                         # http://localhost:5173
curl -X POST localhost:5173/api/reindex   # rebuild index.json after seeding
```

### Testing without an Anthropic key

`scripts/mock-anthropic.mjs` is a scripted stand-in for the Anthropic API (read_page → write_page "tailscale" → done). It exercises the full pipeline — input box → Workflow → tool loop → write seam → toast.

```sh
node scripts/mock-anthropic.mjs &   # listens on :8788
```

and in `.dev.vars`:

```
ANTHROPIC_API_KEY=mock-key-local-test
ANTHROPIC_BASE_URL=http://localhost:8788
```

Note: the mock resets its script per process — restart it to run another synthesis job.

## Deploy

Requires `wrangler login` on the right account, then:

```sh
pnpm exec wrangler r2 bucket create my-wiki   # once
pnpm exec wrangler secret put ANTHROPIC_API_KEY
pnpm run deploy
```
