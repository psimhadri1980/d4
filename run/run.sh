#!/usr/bin/env bash
# D4's one entry point: run/run.sh [<runtime>:]<component>:<command> [args]. See `run/run.sh help`.
# Finds Node 24 (.node-version, through nvm when the shell's node differs) and runs the
# orchestrator in run/orchestrator, which installs its own dependencies on first use.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
want="$(cut -d. -f1 "$root/.node-version")"

if [[ "$(node -v 2>/dev/null)" != "v$want."* && -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use && nvm use --silent "$want" >/dev/null 2>&1 || true
fi
if [[ "$(node -v 2>/dev/null)" != "v$want."* ]]; then
  echo "run.sh needs Node.js $want (.node-version); found: $(node -v 2>/dev/null || echo none)." >&2
  echo "Install it (e.g. nvm install $want) and run the command again." >&2
  exit 1
fi

# The orchestrator reads YAML with the workspace's `yaml` package: install the workspace once.
if [[ ! -d "$root/node_modules/yaml" ]]; then
  echo "run.sh: first run, installing the workspace dependencies (pnpm install)..." >&2
  (cd "$root" && NPM_CONFIG_UPDATE_NOTIFIER=false npx -y "pnpm@$(sed -nE 's/.*"packageManager": *"pnpm@([^"]+)".*/\1/p' package.json)" install --frozen-lockfile) >&2
fi
exec node --disable-warning=ExperimentalWarning "$here/orchestrator/main.ts" "$@"
