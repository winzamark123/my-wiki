# my-wiki

A graph of everything I read in Matter, one page per item, printable as a book. See [DESIGN.md](DESIGN.md) for the product spec and [ARCHITECTURE.md](ARCHITECTURE.md) for how it maps onto Cloudflare.

The pnpm workspace has a static Vite application in `apps/app` and a Cloudflare Worker API in `apps/server-app`. The app uses TanStack Router and TanStack Query; the server owns Matter, R2, Workers AI, cron, and workflows. Run `pnpm` commands from the repository root.

## Local development

```sh
pnpm install
cp apps/server-app/.dev.vars.example apps/server-app/.dev.vars   # Matter, Lulu sandbox, and fal.ai credentials
pnpm dev                                                      # Vite app :5173, server-app :8787
curl -X POST "localhost:8787/api/sync?full=1"                  # pull the Matter queue + archive into the local bucket
curl "localhost:8787/api/sync/<instance id>"                   # sync status
curl -X POST localhost:8787/api/reindex                        # rebuild index.json, embeddings, and links by hand (minutes on first run)
pnpm test                        # unit tests for the pure modules (vitest)
pnpm typecheck
```

Workers AI (embeddings) always runs remotely, even in dev, so `wrangler login` must be on account `e62b5d31403985d71d0a4faae9948728`. `wrangler r2 object …` commands default to the local store; pass `--remote` for the real bucket.

## Deploy

Requires `wrangler login` on the account above, then:

```sh
pnpm --filter @my-wiki/server-app exec wrangler r2 bucket create my-wiki     # once
pnpm --filter @my-wiki/server-app exec wrangler secret put MATTER_API_TOKEN  # masked prompt; never pass the value as an argument
pnpm run deploy:server-app
VITE_API_URL=https://api.example.com pnpm run deploy:app
```

`workers_dev` and preview URLs are disabled in both Wrangler configs. The deployments remain unreachable until custom domains are attached in M5.
