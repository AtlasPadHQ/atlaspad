#!/usr/bin/env bash
# Rehearsal chain for scripts/devnet-e2e.ts when devnet SOL is not available: a local solana-test-validator that
# clones the pump.fun programs and the accounts they need FROM DEVNET (read-only RPC reads; nothing is sent to devnet).
# Then:
#   solana -u http://127.0.0.1:8899 airdrop 50 <devnet-deployer pubkey>       # local faucet only
#   LOCALNET=1 RPC_URL=http://127.0.0.1:8899 scripts/devnet-deploy.sh
#   LOCALNET=1 RPC_URL=http://127.0.0.1:8899 DRY_RUN=false node scripts/devnet-e2e.ts
# --clone-feature-set mirrors devnet (e.g. SBPF v0 deploys are still allowed there). Graduation cannot be rehearsed here (pump's migration bot only runs on the real devnet).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
SRC="${CLONE_FROM:-https://api.devnet.solana.com}"
LEDGER=scripts/out/test-ledger
mkdir -p scripts/out
rm -f scripts/out/localnet-state.json   # --reset wipes the chain, so the recorded lookup table is gone too

args=(--reset --quiet --clone-feature-set --ledger "$LEDGER" --url "$SRC" --rpc-port "${RPC_PORT:-8899}")
for p in 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ \
         MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA; do
  args+=(--clone-upgradeable-program "$p")
done
# Shared pump accounts (devnet values of the tests/fixtures list), plus every devnet fee / buyback recipient and their
# WSOL ATAs (v2 trades pick a fee recipient at random). --maybe-clone skips keys that hold no account.
for a in \
  4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt \
  13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s \
  Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1 TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM \
  6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y \
  So11111111111111111111111111111111111111112 \
  $(node scripts/localnet-clone-keys.cjs "$SRC"); do
  args+=(--maybe-clone "$a")
done
exec solana-test-validator "${args[@]}"
