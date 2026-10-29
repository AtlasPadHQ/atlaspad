# @cornershop/shop-vault-client

TypeScript helpers for the shop-vault program (`6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x`, see `../SPEC.md`).
Depends only on `@solana/web3.js@1.99.0`, `@noble/hashes` and `buffer`; browser- and Worker-safe (no Node APIs).

```ts
import * as sv from "@cornershop/shop-vault-client"; // "file:programs/shop-vault/client" (run `npm run build` first)

const ph = sv.placeHash(place.id);                  // sha256(bare place.id)
const [vault] = sv.vaultPda(ph);                    // pass as pump create_v2 `creator`
const reg = sv.registerLaunch({ launcher, attestor, placeHash: ph, mint });
// launch tx: [cu limit, cu price, pump create_v2(creator = vault), reg, ATA create, pump buy_exact_quote_in_v3]

// Worker, before co-signing (SPEC §8.4): sign only if this returns [].
const violations = sv.checkLaunchMessage(tx.message, { attestor, launcher, mint, placeId, name, symbol, uri,
  maxDevBuyLamports, lookupTable });
```

- Builders for all 16 instructions, PDAs (`configPda`, `vaultPda`, `vaultStatePda`, `programDataPda`, pump helpers),
  decoders (`decodeConfig`, `decodeVaultState`, `decodeBondingCurvePrefix`, `feesWaiting`), error codes
  (`ShopVaultError`, `parseShopVaultError`), `BuildConstants`, `AdminChangedKind`, `CancelRole`, `ConfigFlag`.
- Three keys (SPEC D9): **attestor** (Worker; co-signs `registerLaunch`/`requestClaim` only), **guardian** (offline ops
  key: `setPaused`, `cancelClaim`, veto/consent via `cancelAttestorProposal`/`acceptAttestor` and the guardian
  equivalents, governance recovery via `proposeGovernance({authority: guardian})`), **governance** (Squads vault).
  `initializeConfig` takes all three.
- `registerLaunch` / `requestClaim` include the Instructions sysvar; the program refuses any tx in which another
  top-level instruction calls shop-vault, so build launch and claim txs with exactly one shop-vault instruction.
- After an attestor rotation, `decodeConfig(..).probationUntil` is in the future: new claims unlock at
  `probationUntil + claimWindowSecs` and `decodeVaultState(..).pending.inProbation` is true (the owner may cancel).
- Attestation: v1 = the attestor co-signs the whole tx; `checkLaunchMessage` / `checkClaimMessage` implement the §8.4
  signing policy. Appendix A (`encodeLaunchAttestation`, `encodeClaimAttestation`, `ed25519AttestationInstruction`) is
  reserved for an ed25519-precompile variant; the v1 program does not read it.
- `@pump-fun/pump-sdk@3.2.0` does not load under plain Node ESM (a dependency imports named exports from CJS anchor):
  use `createRequire` in Node scripts, or a bundler (Vite/wrangler) which resolves it.

`npm test` (node:test, 31 tests), `npm run typecheck`, `npm run build` (→ `dist/`), `npm run vectors` regenerates
`test/vectors.json`, which the Rust test `tests/client_vectors.rs` re-encodes and executes against the real program.
