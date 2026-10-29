#!/usr/bin/env bash
# Deploys the DEVNET build (target/deploy-devnet/shop_vault.so) to devnet with the devnet deployer as fee payer and
# upgrade authority (SPEC §11, devnet order step 1). Refuses any cluster whose genesis hash is not devnet; LOCALNET=1
# allows only an http://127.0.0.1 / localhost validator (rehearsal). Never prints key material: the write buffer uses
# a keypair file in .keys/ so a failed deploy never prints a recovery seed phrase; resume with the same command.
#
#   scripts/build.sh && scripts/devnet-deploy.sh            # first deploy
#   UPGRADE=1 scripts/devnet-deploy.sh                      # upgrade an existing devnet deploy (same program id)
#
# Writes scripts/out/<cluster>-deploy.json with the SOL spent and the rent locked.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC="${RPC_URL:-https://api.devnet.solana.com}"
KEYS="${KEYS_DIR:-$(cd ../../.keys && pwd)}"
DEPLOYER="$KEYS/devnet-deployer.json"
PROGRAM_KEY="$KEYS/shop-vault-program.json"
BUFFER_KEY="$KEYS/devnet-deploy-buffer.json"
SO=target/deploy-devnet/shop_vault.so
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
MAINNET_GENESIS=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
rpc_label=$(printf '%s' "$RPC" | sed -E 's#^(https?://[^/?]+).*#\1#') # never print a key in a path or query

genesis=$(solana -u "$RPC" genesis-hash)
cluster=devnet
if [ "$genesis" = "$MAINNET_GENESIS" ]; then echo "REFUSING: $rpc_label is mainnet" >&2; exit 1; fi
if [ "${LOCALNET:-}" = 1 ]; then
  [[ "$RPC" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/?$ ]] || { echo "LOCALNET=1 needs RPC_URL=http://127.0.0.1:<port>" >&2; exit 1; }
  cluster=localnet
elif [ "$genesis" != "$DEVNET_GENESIS" ]; then
  echo "REFUSING: genesis $genesis is not devnet" >&2; exit 1
fi
[ -f "$DEPLOYER" ] || { echo "missing $DEPLOYER" >&2; exit 1; }
[ -f "$PROGRAM_KEY" ] || { echo "missing $PROGRAM_KEY" >&2; exit 1; }

scripts/check-artifact.sh "$SO" devnet
size=$(stat -f%z "$SO" 2>/dev/null || stat -c%s "$SO")
pid=$(solana-keygen pubkey "$PROGRAM_KEY")
dep=$(solana-keygen pubkey "$DEPLOYER")
echo "cluster $cluster ($rpc_label) · program $pid · deployer $dep · $SO $size B"

if [ ! -f "$BUFFER_KEY" ]; then
  (umask 077 && solana-keygen new --no-bip39-passphrase --silent --force --outfile "$BUFFER_KEY" >/dev/null 2>&1)
fi
buf=$(solana-keygen pubkey "$BUFFER_KEY")

if solana -u "$RPC" account "$pid" >/dev/null 2>&1 && [ "${UPGRADE:-}" != 1 ]; then
  echo "program $pid already exists on $cluster; set UPGRADE=1 to upgrade it" >&2; exit 1
fi

lamports() { solana -u "$RPC" balance "$1" --lamports 2>/dev/null | awk '{print $1}'; }
before=$(lamports "$dep")
echo "deployer balance before: $before lamports"
need=$(solana -u "$RPC" rent $((size * 2 + 45)) --lamports | awk '/Rent-exempt minimum/{print $(NF-1)}')
if [ "$before" -lt "$need" ]; then
  echo "deployer $dep has $before lamports; the deploy needs about $need (buffer + program data). Fund it first." >&2; exit 3
fi

# --max-len = the binary size (SPEC §9); --use-rpc sends the write transactions through the RPC (no TPU/QUIC).
# Output is filtered as a second guard so no seed phrase can ever reach the terminal or a log.
solana -u "$RPC" program deploy "$SO" \
  --program-id "$PROGRAM_KEY" \
  --keypair "$DEPLOYER" \
  --upgrade-authority "$DEPLOYER" \
  --buffer "$BUFFER_KEY" \
  --max-len "$size" \
  --use-rpc \
  --commitment confirmed 2>&1 | grep -viE "seed phrase|recover|keygen" || true

solana -u "$RPC" account "$pid" >/dev/null 2>&1 || { echo "deploy did not complete (buffer $buf keeps the uploaded bytes; re-run to resume)" >&2; exit 1; }
after=$(lamports "$dep")
programdata=$(solana -u "$RPC" program show "$pid" --keypair "$DEPLOYER" 2>/dev/null | awk -F': *' '/ProgramData Address/{print $2}')
pd_lamports=$(lamports "$programdata")
prog_lamports=$(lamports "$pid")
spent=$((before - after))
locked=$((pd_lamports + prog_lamports))
mkdir -p scripts/out
cat > "scripts/out/$cluster-deploy.json" <<JSON
{
  "cluster": "$cluster",
  "programId": "$pid",
  "programData": "$programdata",
  "upgradeAuthority": "$dep",
  "soBytes": $size,
  "soSha256": "$(shasum -a 256 "$SO" | cut -d' ' -f1)",
  "deployerBefore": $before,
  "deployerAfter": $after,
  "spentLamports": $spent,
  "rentLockedLamports": $locked,
  "programDataLamports": $pd_lamports,
  "programAccountLamports": $prog_lamports,
  "feesLamports": $((spent - locked)),
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
cat "scripts/out/$cluster-deploy.json"
solana -u "$RPC" program show "$pid" --keypair "$DEPLOYER"
