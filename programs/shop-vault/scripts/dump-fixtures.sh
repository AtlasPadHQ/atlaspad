#!/usr/bin/env bash
# Dump the real pump.fun programs and the accounts they need from MAINNET (read-only RPC; nothing is signed or sent)
# into tests/fixtures/ for the LiteSVM tests. The .so files and accounts/ are gitignored; manifest.json (slot + sha256)
# is committed so a re-dump can be compared. Override the endpoint with RPC_URL (never commit a keyed URL).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
OUT=tests/fixtures
mkdir -p "$OUT/accounts"

PROGRAMS=(
  "pump      6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
  "pump_fees pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
  "mayhem    MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e"
  "pump_amm  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
)
# Keys shared by every create_v2 / buy / sell / sweep / collect (computed with @pump-fun/pump-sdk 3.2.0 builders
# for random mints and users, intersected, then filtered to accounts that exist on mainnet).
ACCOUNTS=(
  4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf  # pump Global
  8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt  # pump FeeConfig (owner pump_fees)
  13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ  # mayhem global_params
  BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s  # mayhem sol_vault (Global.whitelist_pda)
  Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1  # pump __event_authority
  TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM  # pump mint-authority PDA
  So11111111111111111111111111111111111111112  # WSOL mint
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  # USDC mint (Global.whitelisted_quote_mints[0]; LCH-08)
  6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP  # pump QuoteControl PDA
  62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV  # Global.fee_recipient (v2 trades)
  94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb  #   its WSOL ATA
  5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD  # Global.buyback_fee_recipients[0]
  HjQjngTDqoHE6aaGhUqfz9aQ7WZcBRjy5xB8PScLSr8i  #   its WSOL ATA
  Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y  # pump global_volume_accumulator
)

SLOT=$(solana -u "$RPC" slot)
for p in "${PROGRAMS[@]}"; do
  set -- $p
  solana -u "$RPC" program dump "$2" "$OUT/$1.so" >/dev/null
done
for k in "${ACCOUNTS[@]}"; do
  solana -u "$RPC" account "$k" --output json --output-file "$OUT/accounts/$k.json" >/dev/null
done

{
  echo "{"
  echo "  \"cluster\": \"mainnet-beta\","
  echo "  \"slot\": $SLOT,"
  echo "  \"dumped_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"files\": {"
  first=1
  for f in $(cd "$OUT" && ls *.so accounts/*.json); do
    [ $first -eq 1 ] || echo ","
    first=0
    printf '    "%s": "%s"' "$f" "$(shasum -a 256 "$OUT/$f" | cut -d' ' -f1)"
  done
  echo
  echo "  }"
  echo "}"
} > "$OUT/manifest.json"
echo "dumped ${#PROGRAMS[@]} programs and ${#ACCOUNTS[@]} accounts at slot $SLOT"
