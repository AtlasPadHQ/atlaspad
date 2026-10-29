#!/usr/bin/env bash
# Usage: scripts/check-artifact.sh <path/to/shop_vault.so> <mainnet|devnet> [--verified]
#
# Refuses (exit 1) unless the binary
#   - is under the 40,960 B size gate (SPEC §9),
#   - carries exactly the expected build-flavour marker ("shop-vault-build:mainnet" / "shop-vault-build:devnet",
#     emitted in ConfigInitialized and stored as Config.flavor), so a devnet binary can never be deployed as mainnet
#     (review finding R2-A3).
# With --verified (required by the go-mainnet checklist, SPEC §11) it also rebuilds with `solana-verify build` (a
# deterministic Docker build of the default = mainnet profile) and requires the candidate's executable hash to equal
# it. A local macOS `cargo build-sbf` will not match: deploy the solana-verify output. Fails closed without
# solana-verify or Docker.
set -euo pipefail
so=${1:?usage: check-artifact.sh <so> <mainnet|devnet> [--verified]}
want=${2:?usage: check-artifact.sh <so> <mainnet|devnet> [--verified]}
verified=${3:-}
case "$want" in mainnet) other=devnet ;; devnet) other=mainnet ;; *) echo "flavour must be mainnet or devnet" >&2; exit 1 ;; esac
[ -f "$so" ] || { echo "missing $so" >&2; exit 1; }

size=$(stat -f%z "$so" 2>/dev/null || stat -c%s "$so")
if [ "$size" -ge 40960 ]; then echo "SIZE GATE FAILED: $so is $size B (>= 40960)" >&2; exit 1; fi
if ! LC_ALL=C grep -aq "shop-vault-build:$want" "$so"; then echo "FLAVOUR CHECK FAILED: $so has no shop-vault-build:$want marker" >&2; exit 1; fi
if LC_ALL=C grep -aq "shop-vault-build:$other" "$so"; then echo "FLAVOUR CHECK FAILED: $so is a $other build" >&2; exit 1; fi
sha=$(shasum -a 256 "$so" | cut -d' ' -f1)
echo "$so: $size B, flavour $want, sha256 $sha"

if [ "$verified" = "--verified" ]; then
  if ! command -v solana-verify >/dev/null || ! command -v docker >/dev/null; then
    echo "VERIFIED BUILD CHECK FAILED: solana-verify and docker are required (cargo install solana-verify)" >&2
    exit 1
  fi
  [ "$want" = mainnet ] || { echo "--verified is for the mainnet artifact only" >&2; exit 1; }
  root=$(cd "$(dirname "$0")/.." && pwd)
  tmp=$(mktemp -d)
  cp "$so" "$tmp/candidate.so" # solana-verify build overwrites target/deploy/shop_vault.so
  solana-verify build "$root" --library-name shop_vault
  vsha=$(solana-verify get-executable-hash "$root/target/deploy/shop_vault.so")
  csha=$(solana-verify get-executable-hash "$tmp/candidate.so")
  if [ "$vsha" != "$csha" ]; then echo "VERIFIED BUILD MISMATCH: candidate $csha, solana-verify $vsha" >&2; exit 1; fi
  echo "candidate equals the solana-verify build: $vsha"
fi
