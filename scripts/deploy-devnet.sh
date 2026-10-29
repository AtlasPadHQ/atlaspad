#!/usr/bin/env bash
# CORNERSHOP devnet deploy (INTEGRATION §10.2). DRY RUN by default; add --execute to act.
#
#   bash scripts/deploy-devnet.sh                     # preflight + plan (sends nothing, changes nothing)
#   bash scripts/deploy-devnet.sh --execute           # program/config/ALT if missing, D1, roles, build, deploy, secrets, smoke
#   bash scripts/deploy-devnet.sh --execute --only deploy,secrets,smoke
#
# Deploys ONLY the Worker `cornershop-devnet` (`wrangler deploy --env devnet`). The demo Worker `cornershop` is never
# touched here (H4). All logic lives in scripts/deploy-devnet.mjs; this wrapper only sets the toolchain PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NODE_NO_WARNINGS=1
exec node scripts/deploy-devnet.mjs "$@"
