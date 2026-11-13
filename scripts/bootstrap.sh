#!/usr/bin/env bash
# Installs everything the test suites need: workspace deps + Playwright Chromium.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci

# Chromium for e2e/local.js. --with-deps needs sudo on Debian/Ubuntu; skip it
# gracefully where sudo is unavailable (e.g. sandboxed dev machines) and let
# system-package setup happen in CI instead.
if command -v sudo >/dev/null 2>&1; then
  npx playwright install --with-deps chromium
else
  npx playwright install chromium
fi
