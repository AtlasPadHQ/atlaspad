#!/usr/bin/env bash
# Builds both profiles with cargo build-sbf and enforces the < 40 KB size gate (SPEC §9, BLD-01).
#   target/deploy/shop_vault.so          default = mainnet (72 h minimum claim window, 7 d rotation delay)
#   target/deploy-devnet/shop_vault.so   --features devnet (60 s .. 24 h claim window, 300 s rotation delay)
# The devnet build has its own --sbf-out-dir, so target/deploy/shop_vault.so is never a devnet artifact, even when
# the mainnet build fails or is interrupted (review finding R2-A3). scripts/check-artifact.sh verifies the flavour.
# Each out dir's shop_vault-keypair.json is a symlink to ../../.keys/shop-vault-program.json (the program id
# 6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x), so build-sbf never generates a stray program key.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
KEY=../../../../.keys/shop-vault-program.json
for dir in target/deploy target/deploy-devnet; do
  mkdir -p "$dir"
  if [ ! -L "$dir/shop_vault-keypair.json" ]; then
    rm -f "$dir/shop_vault-keypair.json"
    ln -s "$KEY" "$dir/shop_vault-keypair.json"
  fi
done
# A devnet .so left in the mainnet out dir by an older build script must not survive.
rm -f target/deploy/shop_vault-devnet.so
cargo build-sbf --features devnet --sbf-out-dir target/deploy-devnet "$@"
cargo build-sbf --sbf-out-dir target/deploy "$@"
scripts/check-artifact.sh target/deploy/shop_vault.so mainnet
scripts/check-artifact.sh target/deploy-devnet/shop_vault.so devnet
