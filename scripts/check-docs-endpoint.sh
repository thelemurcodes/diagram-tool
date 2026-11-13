#!/usr/bin/env bash
# Guard: every docs/*.html page must reference only the production backend.
#
# A stale endpoint here means the published GitHub Pages site silently sends
# visitors' requests to a dead URL (this happened with the legacy Cloud Run
# proxy). Fails on:
#   - any Cloud Run (run.app) reference anywhere in a docs page
#   - any non-empty CONFIG.API_ENDPOINT other than the production backend
# An empty API_ENDPOINT is the documented LOCAL TEST mode and is allowed.
set -u

PROD_ENDPOINT="https://backend-production-01bfe80e.up.railway.app"
fail=0

shopt -s nullglob
files=(docs/*.html)
if [ ${#files[@]} -eq 0 ]; then
  echo "::error::no docs/*.html pages found — expected at least docs/index.html"
  exit 1
fi

for f in "${files[@]}"; do
  if grep -n "run\.app" "$f"; then
    echo "::error file=$f::legacy Cloud Run endpoint (run.app) referenced; use $PROD_ENDPOINT"
    fail=1
  fi

  while IFS='|' read -r lineno url; do
    [ -n "$url" ] || continue
    if [ "$url" != "$PROD_ENDPOINT" ]; then
      echo "::error file=$f line=$lineno::API_ENDPOINT is '$url' — must be $PROD_ENDPOINT (or empty for LOCAL TEST mode)"
      fail=1
    fi
  done < <(grep -n 'API_ENDPOINT' "$f" \
    | sed -n 's/^\([0-9]*\):.*API_ENDPOINT: *"\?\(http[^" ]*\)"\?.*$/\1|\2/p')
done

if [ "$fail" -eq 0 ]; then
  echo "OK: all docs/*.html reference only $PROD_ENDPOINT"
fi
exit $fail
