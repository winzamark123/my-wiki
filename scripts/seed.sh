#!/usr/bin/env bash
# seed the LOCAL dev bucket with sample pages, then rebuild the index via the dev server
set -euo pipefail
cd "$(dirname "$0")/.."

for f in seed/*.md; do
  slug=$(basename "$f" .md)
  pnpm exec wrangler r2 object put "my-wiki/wiki/$slug.md" --local --file "$f" --content-type text/markdown
done

echo "seeded. if dev server is running: curl -X POST localhost:5173/api/reindex"
