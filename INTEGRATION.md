# AtlasPad (internal id cornershop) Phase 2: integration contract (real mode on devnet, scripted flip to mainnet)

> **RPC PROVIDER CHANGE (2026-10-08, overrides everything below and any older reference to Helius):** the RPC provider is **Alchemy** (the AtlasPad Alchemy app, Solana Mainnet + Devnet enabled). Secret name **`ALCHEMY_API_KEY`** (in `.env.server`, server-only, same invisibility rules as before). URLs: `https://solana-devnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` and `https://solana-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`. Use only standard Solana JSON-RPC methods (no Helius-only APIs): priority fees via `getRecentPrioritizationFees` (percentile over recent slots for the pump program accounts, clamped as specified), parsed trades via `getSignaturesForAddress` + `getTransaction`. Bundle/response leak checks look for `g.alchemy.com` and the key value instead of `helius-rpc.com`/`api-key=`.


> **INTEGRATION LOG (2026-10-08, integrator; overrides the sections it names):**
>
> - **Live on devnet:** `cornershop-devnet` at https://cornershop-devnet.tiejiucai.workers.dev (D1 `cornershop-devnet`
>   `49f55e00-8d36-4732-a148-ab76f0bc6108`, cron `* * * * *`). Program `6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x`,
>   Config `FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY`, ALT `AcC53qbWCpZUsSXjaN36h35KyqQQH37oreFnrbZBtB6G` (frozen,
>   14 keys), crank `zAaxnjjoekcmLct3rCTZ6xGTJsBh6wTYovxubSSNDVz`, faucet `DkvG3Qe8xiKxkBqYaut74yZd4Uhu51jR4iFDvzQKrywZ`
>   (all in `deploy/devnet.json`). The demo Worker `cornershop` was not touched.
> - **§11.1 applied:** exact pins in `package.json`, `.npmrc install-links=true` (one web3.js copy; unit test
>   `src/chain/singleWeb3.test.ts`), `src/env.d.ts`, `.gitignore`, `public/_headers`, OPS's `package.json` scripts
>   (`deploy` now refuses). `vite.config.ts` needed **no** `define`/`dedupe` (CHAIN's day-1 spike).
> - **Wire additions (§0.3):** `HealthResponse.checks.alchemy?` (same value as `helius`, kept for contract stability),
>   `ReportRequest.kind` gains `'manual_claim'`. **Schema additions (§2):** `coins.complete`, `coins.fee_crank_at`;
>   `claims.website_host`, `claims.onchain_at`, `claims.finalized_at`; `indexer_cursors.pending_before|pending_top|
>   pending_top_slot`. Website-code claims are excluded from the one-active-claim index (2 h TTL). New var
>   `POLICY_REFERENCE` (`0` disables the web3.js reference co-sign gate; the stricter `worker/policy.ts` gate always runs).
> - **§4.3:** `lamportsPerToken` uses **15** extra fractional digits (devnet prices are below 1 lamport/token); the
>   Worker, browser and `scripts/lib/events.mjs` share the maths. pump-amm `Pool.virtual_quote_reserves` is a **signed**
>   i128. `/api/config.curve.initialVirtualQuoteReserves` comes from pump Global `initial_virtual_sol_reserves`
>   (1 SOL on devnet, 30 SOL on mainnet), never the @1005 token-quote field.
> - **Price impact (§4.5):** `MAX_PRICE_IMPACT_PCT` is **60 on devnet builds, 15 on mainnet**. Devnet curves start from
>   1 SOL of virtual reserves, so a 0.1 SOL buy moves a fresh devnet curve ≈21%.
> - **Fee reserve (§7.7):** 0.005 SOL (not 0.003): a wallet's first pump buy also pays its Token-2022 ATA and pump's
>   UserVolumeAccumulator. Review uses `estimateLaunchCost(devBuy, {name, symbol, launcher})` (exact on devnet); the
>   owner card shows the withdraw network fee (`VaultView.withdrawCostLamports`, rounded up).
> - **Graduated fees (§3.7, SPEC §8.5):** fees waiting include pump-amm `Pool.creator_fees` when `Pool.coin_creator` is
>   the vault (CHAIN finding); the browser withdraw path sweeps it.
> - **Indexer:** trade ingestion refreshes the touched coins' 24 h aggregates in the same batch, so `/api/coins`,
>   `/api/market` and `/api/coins/:mint?fresh=1` agree straight after a trade.
> - **SOL/USD (§1.8):** the public Pyth Hermes endpoint now answers 401 without a key. Coinbase spot
>   (`api.coinbase.com/v2/prices/SOL-USD/spot`, keyless) is the second fallback and cross-check, fetched only when Pyth
>   fails. `scripts/accuracy-audit.mjs` uses the same fallback.
> - **§10.1:** local scripts use public Solana RPC (or a user-set `RPC_URL`), never the Alchemy key; the key only goes
>   into the Worker secret through stdin. Secrets are set **before** the first deploy (`secrets.required`).
> - **Trading after graduation** goes direct to PumpSwap on both clusters (Jupiter has no devnet; optional mainnet
>   fallback stays P2). **Claim payouts** go only to the connected wallet (it signs `request_claim`).
> - **Icons:** every Material Symbols name must be in `index.html` `icon_names=` (unit test `src/ui/iconSubset.test.ts`).
> - **Open items:** see the integrator's final report (cron not yet observed firing on the new Worker; devnet graduation
>   depends on pump's migration bot, which did not create a pool within 30 min in the program e2e; Workers Paid needed
>   for mainnet).

Status: **contract v1, 2026-10-08**. Four builders work in parallel against this file: **BACKEND**, **CHAIN**, **APP**
and **OPS**. The integrator merges.

User goal: *"get it ready so everything will be ready for testing and i can just flip it to main net, try everything
first make sure everything is fast and accurate"*. That means two things:

1. Real mode on devnet is complete and tested end to end (launch, trade, graduate, claim, withdraw).
2. Mainnet is a config flip plus one scripted, checked deploy that only a human starts (`scripts/go-mainnet.mjs`).

**Precedence.** `programs/shop-vault/SPEC.md` wins on anything on-chain, including the §8.4 co-sign rules.
DESIGN.md wins on visuals and copy. This file wins on code shape, wire formats, ownership and ops. CONTRACTS.md still
applies to Phase-1 demo mode. Its rule "never request a signature" is **replaced in real mode** by §4.7 and §4.9 below.

---

## 0. Ground rules

### 0.1 Hard rules (every builder)

| # | Rule |
|---|---|
| H1 | **Devnet only** for any transaction you send. Never deploy to mainnet and never touch mainnet funds. Read-only mainnet RPC is fine. Every script that sends a transaction checks the genesis hash first. Devnet = `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, mainnet = `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. |
| H2 | **Secrets never leave the server.** `ALCHEMY_API_KEY`, `GOOGLE_SERVER_KEY`, every private key, `HMAC_KEY` and the Twilio and Turnstile secrets must never reach the client bundle, a browser-visible URL, an API response, a log line or a committed file. Scripts read them in-process and pipe them into `wrangler secret put` through stdin, with no echo. Nothing ever prints a key, even partially. |
| H3 | The browser reaches Solana **only** through the Worker's `POST /api/rpc` (§3.6). It never calls a Alchemy or public RPC URL, and the client has no WebSocket subscriptions. |
| H4 | **Only `cornershop-devnet` is deployed in this workflow** (`wrangler deploy --env devnet`). The `cornershop` Worker (Phase-1 demo, live) is left exactly as it is. Nobody runs a bare `wrangler deploy` or `npm run deploy`. |
| H5 | **Real mode has no demo coins, no simulator and no fake prices.** Every number comes from the chain or the D1 registry, which is built from the chain. **Demo mode is unchanged**: `?mode=demo`, or a demo-only build. It makes zero `/api/rpc`, `/api/coins` or `/api/market` calls. |
| H6 | The devnet test wallet, `/api/dev/*` and the "code on screen" phone verifier sit behind a **compile-time** flag and a **runtime** `CLUSTER === 'devnet'` check. They must be absent from mainnet bundles, and `scripts/check-bundle.mjs` proves it (§10). |
| H7 | The attestor key signs **only** inside `/api/launch/cosign` and `/api/claim/cosign`, after the SPEC §8.4 checks pass on the message the Worker decoded itself. There is no generic signing route, ever. |
| H8 | `programs/**` is **read-only** for everyone, including `programs/shop-vault/client`: import it, never edit it. The vault program is finished. |
| H9 | Google ToS still applies: we persist place IDs, plus coordinates for at most 30 days (refreshed by the cron). Coin name, ticker and category are the launcher's input. Google content is never stored and never used as coin art. |

### 0.2 Ownership (edit only your paths; ask for shared changes in `sharedChangesNeeded`)

| Owner | Paths |
|---|---|
| **BACKEND** | `worker/**` (including the contract file `worker/wire.ts`), `migrations/**`, `wrangler.jsonc` |
| **CHAIN** | `src/chain/**` (including the contract file `src/chain/types.ts`), `src/wallet/solanaWallets.ts` (signing), `src/dev/**` (devnet test wallet) |
| **APP** | `src/realdata/**` (new), `src/mode.ts` (contract file), `src/store.ts`, `src/types.ts`, `src/config.ts`, `src/App.tsx`, `src/PanelHost.tsx`, `src/panel/**`, `src/launch/**`, `src/claim/**`, `src/feed/**`, `src/rail/**`, `src/search/**`, `src/map/**`, `src/landing/**`, `src/ui/**`, `src/styles/**`, `src/wallet/` **except** `solanaWallets.ts`. Paths the brief did not list are also assigned to APP: `src/lib/**`, `src/places/**`, `src/share/**`, `src/data/**`, `src/claimsPersistence.test.ts` |
| **OPS** | `scripts/**` (root, new), `deploy/**` (new; public addresses only), `RUNBOOK.md`, `MAINNET-CHECKLIST.md`, `.env.example`, the `"scripts"` section of `package.json` |
| **INTEGRATOR** | `package.json` dependencies, `package-lock.json`, `.npmrc`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `public/**`, `src/main.tsx`, `src/env.d.ts`, `.gitignore`, `CONTRACTS.md`, `README.md`, this file |

Cross-boundary imports that are allowed:

- The Worker imports `src/search/apiTypes.ts`, `src/search/parseMapsLink.ts` (as today) and `src/chain/curve.ts` (pure price math).
  The owners must keep these three **environment-free**: no DOM types, no `import.meta.env`, no `window`.
- APP imports `worker/wire.ts`, and CHAIN's light modules (§4.1).
- CHAIN imports `src/mode.ts` and `worker/wire.ts`.

### 0.3 Contract files (already written, they typecheck; extend, don't break)

- `worker/wire.ts`: every HTTP shape, the RPC allowlist, the launch rules (`launchIneligibility`, `NON_BUSINESS_TYPES`,
  `isOwnBusinessHost`, `PLATFORM_HOSTS`, limits) and `DEV_TEST_PLACE_RE`.
- `src/chain/types.ts`: the chain-layer API types (`TxProgress`, `TxError`, `TxOutcome`, `WalletSigner`, quotes,
  `VaultView`, and so on). It is dependency-free, so the UI can import it without pulling in the chain chunk.
- `src/mode.ts`: `BUILD_CLUSTER`, `APP_MODE`, `IS_REAL`, `CLUSTER`, `assertRealMode()`.

Owners may **add optional fields**. Renaming, removing or retyping anything goes through the integrator.

### 0.4 Where things stand (verified 2026-10-08, read-only)

- Program id `6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x` (same on both clusters). **Not deployed on devnet yet**
  (`AccountNotFound`). It is rehearsed on localnet (`programs/shop-vault/scripts/out/localnet-*.json`, launch tx 1,133 B).
- `.keys/` has `devnet-{attestor,guardian,deployer,launcher,buyer,owner,deploy-buffer}.json` and `shop-vault-program.json`.
  **Every devnet balance is 0 SOL.** OPS must fund the deployer before anything else (§10.2, step 1). This is the first
  blocker. If the airdrop fails, the user must use https://faucet.solana.com with a GitHub login.
- Missing keys (OPS creates them with `solana-keygen new --no-bip39-passphrase --silent`, mode 600, never printed):
  `devnet-crank.json`, `devnet-faucet.json`, and later the `mainnet-*` keys (§1.6).
- No D1 database or Worker named `cornershop-devnet` exists yet (`wrangler d1 list`).
- `.env.server` holds `GOOGLE_SERVER_KEY` and `ALCHEMY_API_KEY`, and no Twilio values.
- The current main bundle is 162 KB gz of JS plus 30 KB gz of CSS (demo data included). The MapLibre chunk is 284 KB gz, lazy.

### 0.5 Priorities (build P0 first; P1 before devnet sign-off; P2 is optional this round)

- **P0**, the full devnet loop:
  - config, D1 and the RPC proxy;
  - registry, market, feed and top;
  - metadata;
  - launch prepare/cosign/confirm;
  - curve buy and sell;
  - claims (screen code) → `request_claim` → finalize → collect + withdraw;
  - the indexer (curve trades);
  - the test wallet and network badge;
  - `deploy-devnet`, `check-bundle`, `smoke` and `e2e-devnet`;
  - the Phase-1 minor fixes (§7.8).
- **P1**:
  - graduation (AMM pool price, PumpSwap trades, AMM fee paths);
  - holders;
  - fee crank;
  - SPEC §8.6 monitoring alerts;
  - coordinate refresh;
  - per-coin share/OG;
  - website-code verification;
  - Twilio adapter (code complete, unit-tested with a fake);
  - accuracy audit;
  - `go-mainnet --dry-run`.
- **P2**:
  - manual-review claim path;
  - Jupiter fallback;
  - Privy email wallets;
  - vanity `…pump` mint pool.

---

## 1. Configuration and environments

### 1.1 Addresses (identical on both clusters unless noted)

| Name | Value |
|---|---|
| shop-vault program | `6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x` |
| Config PDA `["config"]` | `FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY` |
| pump / pump-amm / pump-fees / mayhem | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` / `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` / `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` / `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` |
| ALT (per cluster) | devnet: created by `scripts/create-alt.mjs` → `deploy/devnet.json`. Mainnet: created by `go-mainnet` |

**`ALT_KEYS`**, the exact 14 shared keys in this order. They are identical on both clusters, and the frozen ALT must
hold exactly these:

```
4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf  pump Global
Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1  pump event authority
8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt  pump FeeConfig
13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ  mayhem global_params
BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s  mayhem sol_vault
TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM  pump mint_authority
TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb  Token-2022
TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA  SPL Token
So11111111111111111111111111111111111111112  WSOL mint
5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD  buyback fee recipient (Global.buybackFeeRecipients[0], fixed)
11111111111111111111111111111111              System
FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY  shop-vault Config
MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e  mayhem program
Sysvar1nstructions1111111111111111111111111  Instructions sysvar
```

The list is the same as `ALT_KEYS` in `programs/shop-vault/scripts/devnet-e2e.ts`. The co-signed launch with a dev buy
measures 1,126 B (typical) and 1,169 B (max metadata), under the 1,232 B limit.

### 1.2 `deploy/<cluster>.json`: the single source of truth for on-chain addresses (OPS writes, public data only)

```json
{
  "cluster": "devnet",
  "genesisHash": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "programId": "6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x",
  "programDataSha256": "<sha256 of the deployed .so>",
  "configPda": "FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY",
  "alt": "<base58>",
  "altKeys": ["…14 keys above…"],
  "attestor": "AR4W7wJSk76qpqXGJu5herEmFja8EGrzvjZLxiaF6Wty",
  "guardian": "8FEurcTwYn1qBGGUuQQntBCVgkBtGgh6ZFx65vBNJnnG",
  "governance": "GNm79FtEQQx41LYfVbU9xDQaFDRVQyZ8q85DAWoHe6Bw",
  "upgradeAuthority": "GNm79FtEQQx41LYfVbU9xDQaFDRVQyZ8q85DAWoHe6Bw",
  "crank": "<pubkey of devnet-crank.json>",
  "faucet": "<pubkey of devnet-faucet.json>",
  "claimWindowSecs": 60,
  "updatedAt": "2026-10-08T…Z"
}
```

On devnet, governance is the devnet deployer key, as in the e2e. Mainnet uses the same file shape: `faucet` is
absent, `governance` is the Squads vault A once accepted, and `claimWindowSecs` is 259200.

`ALT_ADDRESS` reaches the Worker through `wrangler deploy --var ALT_ADDRESS:<alt>`, which the deploy scripts run, and
through `.dev.vars.<env>` for local runs. Nobody hand-copies the ALT address.

### 1.3 Build-time vs runtime

| Setting | Where | Values | Effect |
|---|---|---|---|
| `VITE_CLUSTER` | build (Vite env, set by the npm script) | `devnet` · `mainnet` · empty | Empty means a demo-only bundle (the current `cornershop` Worker). `src/mode.ts` → `BUILD_CLUSTER` |
| `VITE_TEST_WALLET` | build | `1` (devnet builds only) | Includes `src/dev/**` via an inline-guarded dynamic import (H6). `build:mainnet` forces it empty, and `check-bundle` fails if any marker survives |
| `VITE_GOOGLE_MAPS_KEY` | build (`.env.local`) | browser key | unchanged |
| `?mode=demo` / `?mode=real` | runtime URL (sticky per tab via sessionStorage `cs_mode`) | | `APP_MODE` (`src/mode.ts`) |
| Worker `define` (`wrangler.jsonc`) | Worker bundle | `__CS_CLUSTER__` = `"devnet"`/`"mainnet"`/`"demo"`, `__CS_DEV_ENDPOINTS__` = `true` (devnet) / `false` | Compile-time removal of `/api/dev/*`, the screen verifier, dev origins and dev test places |
| Worker `vars.CLUSTER` | runtime | `devnet`/`mainnet`; **unset = Phase-1 demo Worker** | Selects the Alchemy endpoint and the expected genesis. Every real route returns `404 not_enabled` when unset |
| `GET /api/config` | runtime (Worker → client) | `ConfigResponse` | ALT, attestor, claim window, paused, priority fee, curve constants, features, explorer templates |

On boot in real mode, the client fetches `/api/config` and asserts `config.cluster === BUILD_CLUSTER`. On a mismatch it
stays read-only and shows a blocking banner: "Network mismatch. Reload, or open the demo."

### 1.4 `wrangler.jsonc` (BACKEND): three configs in one file

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  // TOP LEVEL = the Phase-1 DEMO Worker `cornershop`. Do not deploy it in this workflow (H4).
  "name": "cornershop",
  "main": "worker/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],           // web3.js needs Buffer in the Worker
  "assets": { "directory": "./dist", "binding": "ASSETS", "not_found_handling": "single-page-application",
              "run_worker_first": ["/api/*", "/c/*", "/p/*"] },
  "observability": { "enabled": true },
  "define": { "__CS_CLUSTER__": "\"demo\"", "__CS_DEV_ENDPOINTS__": "false" },
  "env": {
    "devnet": {
      "name": "cornershop-devnet",
      "workers_dev": true,
      "assets": { "directory": "./dist-devnet", "binding": "ASSETS", "not_found_handling": "single-page-application",
                  // every page through the Worker first (the sanctions geo-block, worker/geo.ts); static files stay static
                  "run_worker_first": ["/*", "!/assets/*", "!/favicon.svg", "!/og.png", "!/terms", "!/terms.html", "!/privacy", "!/privacy.html"] },
      "define": { "__CS_CLUSTER__": "\"devnet\"", "__CS_DEV_ENDPOINTS__": "true" },
      "vars": {
        "CLUSTER": "devnet",
        "PUBLIC_ORIGIN": "https://cornershop-devnet.tiejiucai.workers.dev",
        "PROGRAM_ID": "6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x",
        "ALT_ADDRESS": "",                                // injected with --var from deploy/devnet.json
        "MAX_DEV_BUY_LAMPORTS": "1000000000",
        "PRIORITY_FEE_DEFAULT": "10000",
        "TURNSTILE_SITE_KEY": "",
        "PRIVY_APP_ID": "",
        "FEATURE_WEBSITE_VERIFY": "1",
        "BUILD_ID": "dev"                                 // injected with --var
      },
      "d1_databases": [{ "binding": "DB", "database_name": "cornershop-devnet",
                         "database_id": "__D1_DEVNET_ID__", "migrations_dir": "migrations" }],
      "ratelimits": [
        { "name": "RL_READ",   "namespace_id": "2101", "simple": { "limit": 600, "period": 60 } },
        { "name": "RL_FRESH",  "namespace_id": "2102", "simple": { "limit": 30,  "period": 60 } },
        { "name": "RL_GOOGLE", "namespace_id": "2103", "simple": { "limit": 30,  "period": 60 } },
        { "name": "RL_RPC",    "namespace_id": "2104", "simple": { "limit": 300, "period": 60 } },
        { "name": "RL_SEND",   "namespace_id": "2105", "simple": { "limit": 30,  "period": 60 } },
        { "name": "RL_WRITE",  "namespace_id": "2106", "simple": { "limit": 10,  "period": 60 } },
        { "name": "RL_CLAIM",  "namespace_id": "2107", "simple": { "limit": 6,   "period": 60 } }
      ],
      "triggers": { "crons": ["* * * * *"] },
      "observability": { "enabled": true },
      "secrets": { "required": ["ALCHEMY_API_KEY", "GOOGLE_SERVER_KEY", "ATTESTOR_SECRET", "CRANK_SECRET",
                                 "HMAC_KEY", "DEV_FAUCET_SECRET"] }
    },
    "mainnet": {
      "name": "cornershop",                                 // the go-mainnet flip replaces the demo here
      "workers_dev": true,                                  // workers.dev + www 301 to PUBLIC_ORIGIN (worker/canonical.ts)
      "routes": [{ "pattern": "atlaspad.online", "custom_domain": true }, { "pattern": "www.atlaspad.online", "custom_domain": true }],
      "minify": true,
      "assets": { "directory": "./dist-mainnet", "binding": "ASSETS", "not_found_handling": "single-page-application",
                  // every page through the Worker first (geo-block, canonical-host redirect); static files stay static
                  "run_worker_first": ["/*", "!/assets/*", "!/favicon.svg", "!/og.png", "!/terms", "!/terms.html", "!/privacy", "!/privacy.html"] },
      "define": { "__CS_CLUSTER__": "\"mainnet\"", "__CS_DEV_ENDPOINTS__": "false" },
      "vars": { "CLUSTER": "mainnet", "PUBLIC_ORIGIN": "https://atlaspad.online",
                "PROGRAM_ID": "6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x", "ALT_ADDRESS": "",
                "MAX_DEV_BUY_LAMPORTS": "1000000000", "PRIORITY_FEE_DEFAULT": "50000",
                "TURNSTILE_SITE_KEY": "", "PRIVY_APP_ID": "", "FEATURE_WEBSITE_VERIFY": "1", "BUILD_ID": "" },
      "d1_databases": [{ "binding": "DB", "database_name": "cornershop-mainnet",
                         "database_id": "__D1_MAINNET_ID__", "migrations_dir": "migrations" }],
      "ratelimits": [ /* same seven names, namespace_id 3101…3107 */ ],
      "triggers": { "crons": ["* * * * *"] },
      "observability": { "enabled": true },
      "secrets": { "required": ["ALCHEMY_API_KEY", "GOOGLE_SERVER_KEY", "ATTESTOR_SECRET", "CRANK_SECRET", "HMAC_KEY",
                                 "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SID", "TURNSTILE_SECRET_KEY"] }
    }
  }
}
```

- Placeholders `__D1_DEVNET_ID__` / `__D1_MAINNET_ID__`: OPS scripts may replace **only these exact tokens**, once,
  after creating the database. While the mainnet placeholder is still there, `--env mainnet` cannot deploy, which is
  intended.
- **No KV, no R2, no Durable Objects.** Images and metadata live in D1 (§2). D1 gives read-after-write consistency
  everywhere. KV can take up to 60 s to reach another region, and pump.fun or Phantom fetch the URI seconds after a
  launch. R2 needs account enablement.
- **The Cache API is a no-op on `*.workers.dev`.** Use in-isolate TTL maps plus `cache-control` headers. Cache API
  code is optional and only helps once a custom domain exists.
- Keep Workers Logs on. **Never `console.log` a URL or a fetch init that holds the Alchemy key.** Do not enable trace
  sampling that records outgoing subrequest URLs.
- If the deploy fails on the account's cron-trigger limit, the indexer still runs on demand (§3.7), and RUNBOOK
  documents the fix.

### 1.5 Bindings, limits and plan

D1 `DB` · 7 rate-limit bindings · 1 cron (every minute) · static assets. **Workers Free** limits are 10 ms CPU, 50
fetch subrequests and 50 D1 queries per invocation. Design the cron and every handler to fit them:

- batch D1 writes with `DB.batch`;
- at most 40 fetches per cron run;
- carry any leftover work over to the next run.

**Workers Paid ($5/mo) is required for mainnet** (MAINNET-CHECKLIST) and recommended for devnet if the cron hits CPU
limits.

### 1.6 Secrets per environment (`wrangler secret put <NAME> --env <env>`, value through stdin only)

| Secret | devnet | mainnet | Source / format |
|---|---|---|---|
| `ALCHEMY_API_KEY` | ✓ | ✓ | `.env.server`. The user's Alchemy app key (server-only, invisible). Optionally a separate AtlasPad Alchemy app before mainnet (checklist) |
| `GOOGLE_SERVER_KEY` | ✓ | ✓ | `.env.server` |
| `ATTESTOR_SECRET` | `.keys/devnet-attestor.json` | `.keys/mainnet-attestor.json` | base64 of the 64-byte Solana secret key (seed‖pubkey). The Worker builds an Ed25519 JWK `{kty:'OKP',crv:'Ed25519',d:b64url(seed),x:b64url(pub)}` for WebCrypto |
| `CRANK_SECRET` | `.keys/devnet-crank.json` (≈0.2 SOL) | `.keys/mainnet-crank.json` (≈0.1 SOL; the watchdog warns below 0.02) | same format. Fee payer for `finalize_claim` and the fee-collect crank only |
| `HMAC_KEY` | `.keys/devnet-hmac.key` (random 32 B) | `.keys/mainnet-hmac.key` | base64. Domain-separated HMACs for phone hashes (`phone:`), IP hashes (`ip:`) and tokens (`tok:`) |
| `DEV_FAUCET_SECRET` | `.keys/devnet-faucet.json` (≥3 SOL) | **must not exist** | same format as the attestor key |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID` | optional (unused: screen code) | optional (all three or none; mainnet launches without them) | from the user's Twilio account. The Verify service must have `code_length = 6` |
| `TURNSTILE_SECRET_KEY` | optional | required (`TURNSTILE_SITE_KEY` var as well) | Cloudflare dashboard |
| `JUPITER_API_KEY` | – | optional (P2) | |
| `ALERT_WEBHOOK_URL` | optional | this **or** `ALERT_EMAIL_TO` is required (go-mainnet: website-code claims get their human check there before unlock) | Discord/Slack webhook for §3.7 alerts and the owner alerts (`worker/ownerAlerts.ts`: every claim, dispute, report, opt-out and manual review) |
| `ALERT_EMAIL_TO` | optional | this **or** `ALERT_WEBHOOK_URL` is required | `.env.server`. The free alert email (`worker/email.ts`): the owner's address, a verified destination address in Cloudflare Email Routing. The Worker's unrestricted `send_email` binding `ALERT_EMAIL` (wrangler.jsonc env.devnet / env.mainnet) sends the same alerts from `vars.ALERT_EMAIL_FROM` (`alerts@atlaspad.online`). Never in a committed file |

The Worker derives the attestor pubkey from `ATTESTOR_SECRET`. `/api/health` and `/api/config` compare it with
on-chain `Config.attestor`. On a mismatch, the cosign routes answer `503 unavailable`.

### 1.7 RPC (the Alchemy rule)

- **URL.** The Worker builds `https://solana-{devnet|mainnet}.g.alchemy.com/v2/${ALCHEMY_API_KEY}` inside one function
  (`worker/solana.ts → rpcUrl(env)`). Nothing else may create or log that string.
- **Genesis check.** On first use per isolate, check `getGenesisHash` against the hash expected for `CLUSTER` (H1).
  If it does not match, every chain route returns `503 chain_mismatch`.
- **Responses.** The proxy re-serializes upstream JSON-RPC payloads (§3.6). As a last guard, if a response body
  contains the key string, it replaces the key with `[redacted]` and writes an alert.
- **Client.** The client uses `/api/rpc` only. CHAIN's `Connection` is `new Connection(new URL('/api/rpc', location.origin).href,
  { commitment: 'confirmed', disableRetryOnRateLimit: true, wsEndpoint: 'wss://invalid.invalid' })`. Never call
  `confirmTransaction` or any `on*` subscription method (§4.7).

### 1.8 SOL/USD

- The Worker cron fetches the price **every minute**:
  1. Jupiter Price v3: `https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112` (`usdPrice`).
     When `JUPITER_API_KEY` is set, use `https://api.jup.ag/price/v3` with the `x-api-key` header instead.
  2. Fallback: Pyth Hermes
     `https://hermes.pyth.network/v2/updates/price/latest?ids[]=0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d&parsed=true`
     (price × 10^expo).
- It stores the result in D1 `kv_meta('sol_usd')` together with `at`.
- If the two sources differ by more than 2%, keep Jupiter's value and write an alert.
- The price is served in `/api/config`, `/api/coins`, `/api/market` and `/api/top`. The client never calls a price API.
- Devnet shows **real** SOL/USD, so the UI looks realistic. The DEVNET badge explains that test SOL is worthless.

### 1.9 Feature flags

| Flag | Rule |
|---|---|
| Test wallet | Build `VITE_TEST_WALLET=1 && VITE_CLUSTER=devnet` **and** runtime `config.cluster==='devnet' && config.features.testWallet`. `features.testWallet` is true whenever `__CS_DEV_ENDPOINTS__` and `CLUSTER==='devnet'`; it does **not** depend on the faucet (round-1 fix: a funded test wallet must never disappear). `features.faucet` (devnet: faucet ≥ 0.3 SOL, the payout floor; round 2) gates only airdrops / the auto top-up |
| Privy email login | `features.privy = !!PRIVY_APP_ID`. **In real mode "Continue with email" stays hidden, even with `features.privy`:** the email screens are the demo's mock and no Privy adapter is built (P2). `src/wallet/emailLogin.ts` `PRIVY_ADAPTER_BUILT` flips only together with a real integration, so setting `PRIVY_APP_ID` alone changes nothing. Demo mode keeps the mocked email wallet |
| Phone verification | `features.phoneVerification`: devnet `'screen'`. Mainnet `'call'` when all three `TWILIO_*` secrets are present, otherwise `'none'`: the claim modal then says "Phone check isn't switched on yet. Verify with a code on your website." and offers the website code (or `hello@atlaspad.online` when the listing has no website of its own); `/api/health` reports `phone: 'n/a'` (`'missing'` when only some `TWILIO_*` are set) |
| Turnstile | `features.turnstileSiteKey` is non-null when `TURNSTILE_SITE_KEY` is set. Then `/api/claim/call` requires `turnstileToken` |
| Website verification | `FEATURE_WEBSITE_VERIFY=1` (P1) |
| Manual review | `FEATURE_MANUAL_REVIEW`: `'1'` on, `'0'` off, unset = on for devnet, off for mainnet (until its tooling exists). `features.manualReview`; when off the claim modal hides the Manual card and `/api/claim/manual` / `/api/report` `kind:'manual_claim'` answer `404 not_enabled` |
| Jupiter fallback | `features.jupiter` (mainnet only, P2) |

### 1.10 Local development

- `npm run dev:devnet` runs Vite on :5173 with `VITE_CLUSTER=devnet VITE_TEST_WALLET=1`.
- `npm run worker:devnet` runs `wrangler dev --env devnet --port 8787` against local D1. Apply migrations first with
  `wrangler d1 migrations apply cornershop-devnet --env devnet --local`.
- `node scripts/dev-vars.mjs devnet` writes `.dev.vars.devnet` (mode 600, gitignored) from `.env.server`, `.keys` and
  `deploy/devnet.json` without printing anything.
- Local dev origins (`http://localhost:5173|4173`, `http://127.0.0.1:8787`, `http://localhost:8787`) pass the origin
  check only when `__CS_DEV_ENDPOINTS__`.

---

## 2. D1 schema (BACKEND: `migrations/0001_phase2.sql`)

```sql
-- Content-addressed coin art + metadata JSON (served at /img/:id.:ext and /meta/:id.json).
CREATE TABLE assets (
  id TEXT PRIMARY KEY,                                     -- hex(sha256(bytes))[0..32]
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  bytes BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  created_at INTEGER NOT NULL, ip_hash TEXT
);
CREATE TABLE metadata (
  id TEXT PRIMARY KEY,                                     -- hex(sha256(json))[0..32]
  json TEXT NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL, description TEXT NOT NULL,
  image_id TEXT NOT NULL REFERENCES assets(id), place_id TEXT NOT NULL,
  used_by_mint TEXT, created_at INTEGER NOT NULL, ip_hash TEXT
);

-- Registry: one official coin per Google place (mirrors on-chain VaultState; the chain is the source of truth).
CREATE TABLE coins (
  place_id            TEXT PRIMARY KEY,                    -- canonical Google place.id (or devnet 'cornershop-test:*')
  place_hash          TEXT NOT NULL UNIQUE,                -- hex sha256(utf8(place_id)) = vault seed
  mint                TEXT NOT NULL UNIQUE,
  vault               TEXT NOT NULL,
  vault_state         TEXT NOT NULL,
  bonding_curve       TEXT NOT NULL,
  ticker              TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL,
  emoji               TEXT NOT NULL,
  bg                  TEXT NOT NULL,
  image_id            TEXT REFERENCES assets(id),
  metadata_id         TEXT NOT NULL REFERENCES metadata(id),
  launcher            TEXT NOT NULL,
  created_at          INTEGER NOT NULL,                    -- ms, block time of the launch tx
  launch_sig          TEXT NOT NULL UNIQUE,
  launch_slot         INTEGER NOT NULL,
  cluster             TEXT NOT NULL CHECK (cluster IN ('devnet','mainnet')),
  lat REAL, lng REAL, coords_expire_at INTEGER,           -- Google ToS: ≤ 30 days, refreshed by cron
  status              TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','hidden')),  -- moderation (UI only)
  graduated           INTEGER NOT NULL DEFAULT 0,
  pool                TEXT, pool_base_vault TEXT, pool_quote_vault TEXT,
  -- market mirror (indexer; u64 as INTEGER, all < 2^63)
  v_sol INTEGER, v_tok INTEGER, real_sol INTEGER, real_tok INTEGER, supply INTEGER,
  price_lamports      REAL,                                -- lamports per whole token
  mcap_lamports       INTEGER,
  progress_pct        REAL,
  vol24h_lamports     INTEGER NOT NULL DEFAULT 0,
  change24h_pct       REAL,
  last_trade_at       INTEGER,
  holders             INTEGER, holders_at INTEGER,
  -- vault mirror
  fees_earned_lamports      INTEGER NOT NULL DEFAULT 0,
  fees_waiting_lamports     INTEGER NOT NULL DEFAULT 0,
  fees_withdrawable_lamports INTEGER NOT NULL DEFAULT 0,
  fees_collectable_lamports INTEGER NOT NULL DEFAULT 0,
  fees_withdrawn_lamports   INTEGER NOT NULL DEFAULT 0,
  owner TEXT, pending_owner TEXT, unlock_ts INTEGER, in_probation INTEGER NOT NULL DEFAULT 0, owner_since INTEGER,
  claim_nonce INTEGER NOT NULL DEFAULT 0,
  market_slot INTEGER, market_at INTEGER, vault_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE INDEX coins_geo        ON coins(lat, lng) WHERE status = 'live';
CREATE INDEX coins_mcap       ON coins(mcap_lamports DESC) WHERE status = 'live';
CREATE INDEX coins_fees       ON coins(fees_earned_lamports DESC) WHERE status = 'live';
CREATE INDEX coins_created    ON coins(created_at DESC);
CREATE INDEX coins_launcher   ON coins(launcher);
CREATE INDEX coins_owner      ON coins(owner);
CREATE INDEX coins_activity   ON coins(last_trade_at DESC);

CREATE TABLE trades (
  sig TEXT NOT NULL, ix INTEGER NOT NULL,                  -- ix = event index inside the tx (a tx can hold several)
  mint TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  sol_lamports INTEGER NOT NULL, tokens INTEGER NOT NULL, trader TEXT NOT NULL,
  price_lamports REAL NOT NULL, creator_fee_lamports INTEGER NOT NULL DEFAULT 0,
  venue TEXT NOT NULL CHECK (venue IN ('curve','amm')), slot INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (sig, ix)
);
CREATE INDEX trades_mint_ts   ON trades(mint, ts DESC);
CREATE INDEX trades_ts        ON trades(ts DESC);
CREATE INDEX trades_trader_ts ON trades(trader, ts DESC);

CREATE TABLE launch_reservations (
  id TEXT PRIMARY KEY,                                     -- random 128-bit, base64url
  place_id TEXT NOT NULL, place_hash TEXT NOT NULL, launcher TEXT NOT NULL, mint TEXT NOT NULL UNIQUE,
  metadata_id TEXT NOT NULL, category TEXT NOT NULL, emoji TEXT NOT NULL, bg TEXT NOT NULL,
  dev_buy_lamports INTEGER NOT NULL, lat REAL, lng REAL,
  status TEXT NOT NULL CHECK (status IN ('prepared','cosigned','confirmed','expired','failed')),
  cosign_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, signature TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip_hash TEXT
);
-- one in-flight (co-signed) launch per place; expire stale rows before inserting/updating
CREATE UNIQUE INDEX reservations_one_locked ON launch_reservations(place_id) WHERE status = 'cosigned';

CREATE TABLE claims (
  id TEXT PRIMARY KEY,                                     -- random 128-bit, base64url
  place_id TEXT NOT NULL, mint TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('call','screen','website','manual')),
  phone_hash TEXT,                                         -- HMAC(HMAC_KEY,'phone:'+E.164); never the number
  verify_ref TEXT,                                         -- Twilio verification sid / website code (not secret)
  code_hash TEXT,                                          -- devnet 'screen' only: HMAC of the code
  status TEXT NOT NULL CHECK (status IN ('calling','verified','cosigned','pending_onchain','finalized','cancelled','expired','failed')),
  calls INTEGER NOT NULL DEFAULT 1, wrong_codes INTEGER NOT NULL DEFAULT 0, cosign_count INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT, token_expires_at INTEGER,
  new_owner TEXT, nonce INTEGER, request_sig TEXT, unlock_ts INTEGER, in_probation INTEGER, finalize_sig TEXT,
  requested_at INTEGER NOT NULL, verified_at INTEGER, last_call_at INTEGER, expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, ip_hash TEXT
);
CREATE UNIQUE INDEX claims_one_active ON claims(place_id) WHERE status IN ('calling','verified','cosigned');
CREATE INDEX claims_unlock ON claims(unlock_ts) WHERE status = 'pending_onchain';

CREATE TABLE phone_verifications (                         -- per-number call log for abuse limits (hashed)
  phone_hash TEXT NOT NULL, ts INTEGER NOT NULL, place_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started','approved','failed','blocked'))
);
CREATE INDEX phone_ver_hash_ts ON phone_verifications(phone_hash, ts DESC);

CREATE TABLE rate_counters (                               -- durable daily/hourly caps (bindings cover per-minute)
  key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL
);

CREATE TABLE indexer_cursors (account TEXT PRIMARY KEY, last_sig TEXT, last_slot INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE kv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  -- keys: sol_usd {usd,at,src} · chain_config {paused,attestor,claimWindowSecs,probationUntil,at} · pump_global {…}
  --       priority_fee · indexer_lock {holder,expires} · indexer_last_run · faucet_balance

CREATE TABLE chain_events (                                -- shop-vault events seen by the monitor (SPEC §7, §8.6)
  sig TEXT NOT NULL, ix INTEGER NOT NULL, kind TEXT NOT NULL, place_hash TEXT, data_json TEXT NOT NULL,
  slot INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (sig, ix)
);
CREATE TABLE admin_expectations (                          -- ops pre-registers planned AdminChanged proposals
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER NOT NULL, key TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  kind TEXT NOT NULL, message TEXT NOT NULL, ref TEXT, created_at INTEGER NOT NULL, acked_at INTEGER
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('report','optout','manual_claim')),
  place_id TEXT, mint TEXT, reason TEXT NOT NULL, details TEXT, contact TEXT, created_at INTEGER NOT NULL, ip_hash TEXT
);  -- details, contact and ip_hash are set to NULL after 180 days (cron `retention`, worker/takedown.ts)
-- migration 0003: business opt-outs, written by `scripts/moderate.mjs --optout` (launch prepare → 422 place_opted_out)
CREATE TABLE place_optouts (place_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE INDEX alerts_kind_ref ON alerts(kind, ref, created_at);  -- 0003: owner-alert de-duplication
```

Notes:

- **Saved coins / watch list stay client-side** (localStorage per wallet, as in Phase 1). No table.
- **Raw IPs, phone numbers and codes are never stored.** Only HMACs are stored. The masked phone number is computed per
  request.
- `coins.cluster` must equal `env.CLUSTER`. The Worker refuses to serve rows that don't match.
- Bbox queries that cross the antimeridian (`west > east`) split into two ranges.
- Retention: claims older than 90 days in `expired`/`failed` are deleted by the cron, along with
  `phone_verifications` rows older than 30 days.

---

## 3. Worker API (BACKEND)

### 3.0 Conventions

- **Errors.** Every non-2xx body is `ApiErrorBody` (`worker/wire.ts`). Status map:

  | Status | Codes |
  |---|---|
  | 400 | `bad_request` |
  | 403 | `forbidden_origin` |
  | 404 | `not_found`, `not_enabled` |
  | 405 | `method_not_allowed` |
  | 409 | `taken`, `reserved`, `claim_active`, `claim_pending`, `already_owner` |
  | 410 | `reservation_expired`, `claim_expired` |
  | 413 | `payload_too_large` |
  | 415 | `unsupported_media` |
  | 422 | `not_launchable`, `policy_violation`, `moderation`, `no_phone`, `premium`, `not_own_domain`, `wrong_owner`, `no_coin`, `claim_not_verified`, `not_confirmed` |
  | 423 | `launches_paused` |
  | 429 | `rate_limited`, `too_many_attempts`, `faucet_cap` (all with `Retry-After`) |
  | 451 | `region_blocked` (visitor), `place_region_blocked` (business), `wallet_blocked` (OFAC list): sanctions, worker/geo.ts + worker/sanctions.ts, RUNBOOK §9 |
  | 502 | `upstream` |
  | 503 | `unavailable`, `not_configured`, `chain_mismatch`, `faucet_empty` |

- **Origin.** Every POST and every `/api/rpc` call has its `Origin` checked when the header is present: it must be
  `PUBLIC_ORIGIN`, or one of the dev origins when `__CS_DEV_ENDPOINTS__`. Otherwise the response is `403 forbidden_origin`.
- **Canonical host** (`worker/canonical.ts`, before any route). On an origin other than `PUBLIC_ORIGIN` (mainnet:
  `www.atlaspad.online`, `cornershop.tiejiucai.workers.dev`, plain `http://` or another port), GET/HEAD outside `/api`
  → `301` to the same path and query on `PUBLIC_ORIGIN`; `/api/*` and other methods →
  `421 {"error":"wrong_host","message":…,"origin":…}` (outside the `ApiErrorCode` set: no client ever sees it). Local
  hosts and a Worker without `PUBLIC_ORIGIN` are exempt.
- **CORS.** No CORS headers on `/api/*`. `/meta/*` and `/img/*` send `access-control-allow-origin: *`.
- **Bodies.** JSON bodies are limited to 16 KB, except `/api/metadata` (260 KB multipart) and `/api/rpc` (8 KB).
- **IP.** `cf-connecting-ip` is used only as `HMAC('ip:'+ip)`, truncated to 16 bytes hex.
- **Cache headers:**

  | Route | cache-control |
  |---|---|
  | `/api/config` | `public, max-age=30` |
  | `/api/coins` | `public, max-age=5, stale-while-revalidate=25` |
  | `/api/top` | `public, max-age=15` |
  | `/api/market` | `public, max-age=2` |
  | `/api/feed` | `public, max-age=3` |
  | `/api/coins/:mint` | `public, max-age=5`; with `fresh=1`: `no-store` |
  | `/meta/*`, `/img/*` | `public, max-age=31536000, immutable`, plus `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'` |
  | everything else | `no-store` |

- **In-isolate caches.** Curve/pool accounts: 4 s (round-1: 2 s never hit at the 5 s viewer cadence). Google eligibility: 10 min, memory only, never persisted.
  Blockhash: 2 s. ALT account: forever (it is frozen). Config: 30 s.
- **Demo Worker** (`vars.CLUSTER` unset, `__CS_CLUSTER__ === "demo"`). Phase-1 routes behave exactly as today:
  `/api/health`, `/api/resolve`, `/api/claim/phone`, `/api/listing/:id`, the simulated `/api/claim/start` and
  `/api/claim/verify`, `/api/og/*`, and the `/c/` and `/p/` share pages. Every Phase-2 route returns `404 not_enabled`.
- **Real Workers keep every Phase-1 route too.** `?mode=demo` on devnet uses them unchanged, and its ClaimFlow keeps
  its local simulation.

### 3.1 Route table

| Method + path | P | Auth / limits | Purpose |
|---|---|---|---|
| `GET /api/config` | P0 | RL_READ | `ConfigResponse` |
| `GET /api/health` | P0 | RL_READ | `HealthResponse` |
| `GET /api/coins?bbox\|mints\|launcher\|owner\|sort` | P0 | RL_READ | `CoinsResponse` (§3.2) |
| `GET /api/coins/:mint[?fresh=1]` | P0 | RL_READ (fresh: RL_FRESH) | `CoinDetailDTO` |
| `GET /api/market?mints=` | P0 | RL_READ | `MarketResponse` (live curve/pool reads, 2 s shared cache) |
| `GET /api/top?by=mcap\|fees[&bbox]` | P0 | RL_READ | `TopResponse` |
| `GET /api/feed?limit&since&before&bbox&kinds` | P0 | RL_READ | `FeedResponse` |
| `GET /api/place/:placeId` | P0 | RL_READ | `PlaceResponse` (registry only) |
| `GET /api/place/:placeId/eligibility` | P0 | RL_GOOGLE + 200/day/IP | `EligibilityResponse` (Google lookup) |
| `POST /api/metadata` | P0 | RL_WRITE + 60/day/IP | `MetadataUploadResponse` |
| `GET /meta/:id.json`, `GET /img/:id.:ext` | P0 | none (immutable) | stored JSON / image bytes |
| `POST /api/launch/prepare` | P0 | RL_WRITE + 100/day/IP | `LaunchPrepareResponse` |
| `POST /api/launch/cosign` | P0 | RL_WRITE, ≤ 5 per reservation | `LaunchCosignResponse` (attestor signature) |
| `POST /api/launch/confirm` | P0 | RL_READ | `LaunchConfirmResponse` |
| `POST /api/index/tx` | P0 | RL_WRITE | `IndexTxResponse` |
| `GET /api/claim/phone?placeId` | exists | as today | masked listing phone (Phase 1) |
| `GET /api/claim/status?placeId` | P0 | RL_READ | `ClaimStatusResponse` |
| `POST /api/claim/call` | P0 | RL_CLAIM + D1 caps (§3.5) | `ClaimCallResponse` |
| `POST /api/claim/check` | P0 | RL_CLAIM, 3 wrong per claim | `ClaimCheckResponse` |
| `POST /api/claim/cosign` | P0 | RL_CLAIM, ≤ 5 per claim | `ClaimCosignResponse` |
| `POST /api/claim/confirm` | P0 | RL_READ | `ClaimConfirmResponse` |
| `POST /api/claim/website` | P1 | RL_CLAIM, 20/day/place | `ClaimWebsiteResponse` |
| `POST /api/claim/manual` | P2 | RL_WRITE | stores a `reports` row, kind `manual_claim`; `404 not_enabled` unless `FEATURE_MANUAL_REVIEW` (§1.9) |
| `POST /api/report` | P0 | RL_WRITE + 20/day/IP | 204; alerts the site owner (report, dispute = a report while a claim is in its public window, opt-out, manual review) |
| `POST /api/rpc` | P0 | RL_RPC; send/simulate also RL_SEND | JSON-RPC proxy (§3.6) |
| `POST /api/dev/airdrop` | P0 | devnet only (H6) | `DevAirdropResponse` |
| `scheduled()` cron | P0 | – | indexer (§3.7) |
| `/c/:id`, `/p/:id`, `/api/og/*` | P1 | – | share pages. `/c/<mint>` gets `$TICKER` from D1 and uses the coin image as `og:image`. Origin = `PUBLIC_ORIGIN` (replaces the hard-coded `ORIGIN` in `worker/share.ts`) |

### 3.2 Read endpoints

- **`/api/coins`.**
  - `bbox=w,s,e,n` must be snapped outward to 0.01° by the client (shared cache keys). Results are ordered by
    `mcap_lamports DESC` and capped at `limit` (default 300, max 500).
  - `mints` takes at most 100.
  - `sort=new` returns the newest first. `launcher=`/`owner=` select by wallet.
  - Hidden coins are never returned.
  - Every response includes `solUsd`.
- **`/api/coins/:mint`.** Returns the row, plus the last 50 trades, `history` (48 × 30-min buckets, last-trade price
  per bucket, forward-filled, seeded with the initial curve price) and `ticks` (last 60 trade prices).
  - `fresh=1` re-reads `[curve, vault, vault_state, pumpCreatorVault(vault), vaultWsolAta(vault)]`, plus the AMM WSOL
    creator vault if graduated, in **one** `getMultipleAccounts`. It recomputes `market`, `fees` and `owner`, writes
    them back to D1, and returns them.
- **`/api/market`.**
  - For curve coins it reads bonding curves; for graduated coins it reads pool base/quote vaults (SPL amount @64).
  - Misses are batched into one `getMultipleAccounts` (≤ 100). Each account is cached for 2 s per isolate.
  - Decoding uses `src/chain/curve.ts`, the same function the browser uses.
  - `vol24hLamports`, `change24hPct` and `lastTradeAt` come from D1.
  - **Opportunistic indexing:** when a curve's `realQuoteReserves` differs from D1 and that mint has not been indexed
    for 10 s, call `ctx.waitUntil(indexMint(mint))`, so the feed stays near real time while anyone is watching.
- **`/api/feed`.**
  - It is a union, newest first, of:
    - `trades` (`kind:'trade'`, dust under 0.001 SOL dropped),
    - `coins.created_at` (`kind:'launch'`, wallet = launcher),
    - claims `pending_onchain` (`stage:'requested'`) and `finalized` — ownership events, **no amount** (`feesLamports: null`);
    - payouts (`stage:'withdrawn'`, `id = withdraw:${sig}:${ix}`): the shop-vault `Withdrawn` events from `chain_events`
      (recorded by the program monitor and immediately by `/api/index/tx` after an owner's withdraw), `feesLamports` = the
      exact amount of that withdrawal, `wallet` = the owner.
  - Event `id`s are stable: `${sig}:${ix}`, `launch:${mint}`, `claim:${claimId}:${stage}`.
  - `since` returns only newer events, for polling.
- **`/api/top`.** `by=mcap` orders by `mcap_lamports`; `by=fees` orders by `fees_earned_lamports`. Default limit 20, max 100.
- **`/api/place/:placeId`.** D1 lookup by `place_id`, plus a `launchInProgress` flag (a co-signed reservation with
  `locked_until > now`). No Google call.
- **`/api/place/:placeId/eligibility`.**
  - Google Places API (New) `GET https://places.googleapis.com/v1/places/{id}` with
    `X-Goog-FieldMask: id,businessStatus,primaryType,types,location` and the server key.
  - The result goes through `launchIneligibility()`. If the place already has a coin (D1 or on-chain VaultState), the
    reason is `taken`.
  - `category` is the prefill from `primaryType`. Use the same mapping as `src/lib/categories.categoryFromGoogle`;
    BACKEND copies the small table into `worker/`.
  - Devnet only: an id matching `DEV_TEST_PLACE_RE` is always `launchable`, category `other`, and gets a deterministic
    location near 51.5469, −0.0712.

### 3.3 Metadata and assets

`POST /api/metadata` takes `multipart/form-data` with the fields `name`, `symbol`, `description`, `placeId` and
`image`. Validation, in order:

1. Body ≤ 260 KB.
2. `name`: NFC-normalised, 1..`NAME_MAX_BYTES` UTF-8 bytes, no control or zero-width characters, no URLs.
3. `symbol` matches `TICKER_RE`.
4. `description` ≤ 280 chars.
5. `placeId` is a Google id (`^[A-Za-z0-9_-]{10,300}$`) or, on devnet only, a `DEV_TEST_PLACE_RE` id.
6. A moderation blocklist (`worker/moderation.ts`: slurs, "official", impersonation of well-known brands and of AtlasPad
   itself, scam words)
   → `422 moderation`.
7. `image`: the declared type and the **magic bytes** must both be PNG, JPEG or WebP. **SVG and GIF are refused.** Size
   ≤ `IMAGE_MAX_BYTES`. Width and height are parsed from the header: square ±2%, each ≤ 1024 px.

Storage and URLs:

- The image goes into `assets` (id = sha256 prefix) and is served as `/img/<id>.png|jpg|webp` with the stored
  content type.
- The metadata JSON is built **by the server**, then stored and served as `/meta/<id>.json`:

  ```json
  {"name":"…","symbol":"…","description":"…","image":"<PUBLIC_ORIGIN>/img/<id>.<ext>","showName":true,
   "createdOn":"<PUBLIC_ORIGIN>","website":"<PUBLIC_ORIGIN>/p/<placeId>"}
  ```

- `description` is the launcher's text, a blank line, then the fixed disclaimer `Community coin. Not affiliated with
  this business unless claimed on atlaspad.online.` (`worker/disclaimer.ts`). The whole stays ≤ 280 chars: the
  launcher's text is shortened with `…`, never the disclaimer. D1 `metadata.description` keeps the launcher's text.
- The URI `<PUBLIC_ORIGIN>/meta/<32 hex>.json` is 90 B on devnet and 66 B on mainnet (https://atlaspad.online), within
  `URI_MAX_BYTES` (100).
- On-chain URIs are **permanent**. Keep `workers_dev` enabled on both Workers forever. The mainnet custom domain is
  **atlaspad.online** (`PUBLIC_ORIGIN`), set before the first mainnet launch.

The client re-encodes uploads to a 512×512 WebP (quality 0.85), or PNG when the browser can't encode WebP. It renders
sticker coins (emoji on `bg`) to a 512×512 PNG, so every coin has an image (APP, §7.4).

### 3.4 Launch: prepare → (browser builds) → cosign → (wallet signs, browser sends) → confirm

**`POST /api/launch/prepare`** (`LaunchPrepareRequest`). Checks, in order:

1. Body shape:
   - base58 32-byte keys, with `launcher ≠ mint`;
   - `devBuyLamports` ∈ [0, `MAX_DEV_BUY_LAMPORTS`];
   - `category` in the union;
   - `emoji` ≤ 2 graphemes;
   - `bg` matches `^#[0-9a-f]{6}$`.
2. The `metadata` row exists, its `place_id` matches, and `used_by_mint` is null.
3. On-chain Config is not paused (cached for 30 s) → otherwise `423 launches_paused`.
4. Google lookup (as in eligibility).
   - **Key the coin on the `id` Google returns.** If it differs from the requested one, use the returned id and return it.
   - `launchIneligibility` → otherwise `422 not_launchable` with `reason`.
5. D1 `coins` already has the place → `409 taken` + `existing`.
6. An on-chain VaultState exists for `sha256(placeId)` → `409 taken`, and the indexer backfills the row.
7. Another launcher holds an active co-signed reservation → `409 reserved` with `retryAfterSec`.
8. Insert a reservation: `status='prepared'`, `expires_at = now + RESERVATION_TTL_MS`, coordinates from step 4. Fill
   `blockhash`/`lastValidBlockHeight` from the 2 s cache. Respond.

**`POST /api/launch/cosign`** (`LaunchCosignRequest`):

1. The reservation exists and is `prepared` (or `cosigned` by the same reservation, for a retry with a fresh
   blockhash). It has not expired, and `cosign_count < 5`.
2. Repeat checks 3, 5 and 6 of prepare (paused, D1 taken, on-chain taken).
3. Take the lock:
   - first expire stale rows: `UPDATE … SET status='expired' WHERE place_id=? AND status='cosigned' AND locked_until < now`;
   - then `UPDATE … SET status='cosigned', locked_until=now+120000, cosign_count=cosign_count+1 WHERE id=?`.
   - If the unique index conflicts → `409 reserved`.
4. Decode the bytes with `VersionedMessage.deserialize`. **`message.serialize()` must be byte-identical to the
   submitted bytes**; otherwise `policy_violation` ("non-canonical message").
5. Load the frozen ALT (`AddressLookupTableAccount` from `getAccountInfo(ALT_ADDRESS)`, cached forever). Then
   `violations = checkLaunchMessage(msg, { attestor, launcher, mint, placeId, name, symbol, uri, maxDevBuyLamports,
   lookupTable, maxComputeUnitLimit: 600_000, maxComputeUnitPriceMicroLamports: 5_000_000n })` from
   `@cornershop/shop-vault-client`. `name`, `symbol` and `uri` come from the stored metadata.
   **Any violation → `422 policy_violation` with `violations`, and nothing is signed.**
6. Sign exactly `msg.serialize()` with WebCrypto Ed25519 (`worker/attestor.ts`, the only importer of
   `ATTESTOR_SECRET`). Return the base64 signature.

**`POST /api/launch/confirm`** (`{reservationId, signature}`). Idempotent:

1. `getSignatureStatuses` must reach `confirmed` or `finalized` with `err === null`. If not visible yet → `202 {status:'pending'}`.
   If it landed with an error → `422 not_confirmed`, with the error in `message`.
2. `getTransaction(sig, {maxSupportedTransactionVersion:0, commitment:'confirmed'})`:
   - its account keys (static + loaded) include the reservation `mint` and `vault_state`;
   - signer 0 is the launcher, and the attestor is a signer.
3. `getAccountInfo(vault_state)` → `decodeVaultState`: `mint`, `launcher` and `placeHash` equal the reservation.
4. In one `DB.batch`:
   - insert `coins` (`created_at = blockTime*1000`, `launch_slot`, coordinates with `coords_expire_at = now + 30 d`);
   - insert the dev-buy trade events decoded from this tx (§3.7);
   - set `metadata.used_by_mint`;
   - set the reservation to `confirmed`.
5. Return `{status:'registered', coin}` with a fresh market read.

**Reconciliation (cron).** Reservations stuck in `cosigned` for more than 30 s are checked against on-chain VaultState.
If it exists, the launch signature comes from `getSignaturesForAddress(vault_state, {limit: 1})` and the confirm path
runs on it. Otherwise the reservation becomes `expired` once `locked_until` has passed.

### 3.5 Claims (real mode)

Flow: `GET /api/claim/status` → `POST /api/claim/call` → `POST /api/claim/check` → (browser builds `request_claim`) →
`POST /api/claim/cosign` → (wallet signs, browser sends) → `POST /api/claim/confirm`. After `unlockTs`, the cron sends
`finalize_claim` (CRANK key), and any user can also finalize from the UI. The owner withdraws with their own signature.
**There are no automatic payouts** (SPEC I1: only the owner can trigger `withdraw`).

**`/api/claim/call`:**

1. Find the coin for the place, or return `422 no_coin` (pre-claims are out of scope in v1).
2. Read on-chain VaultState:
   - `has_pending` → `409 claim_pending`, with `unlockTs` in `message`;
   - the shop is already owned → allowed (re-claim, SPEC §5.3).
3. Only one active claim per place is allowed (partial unique index) → otherwise `409 claim_active` with
   `retryAfterSec ≤ 600`.
4. Turnstile, when configured.
5. Caps before the paid lookup they bound: 3 calls per claim and 45 s between them, then (D1 `rate_counters`) 5 per
   hour per IP, 6 per day per place, and the global Google budget. Over a cap → `429 too_many_attempts` (the budget:
   `429 rate_limited`). An attempt refused or failed before Google is called gives its counts back.
6. Look up the phone server-side. Reuse `handlePhone`'s Google lookup: `internationalPhoneNumber`, premium blocking,
   masking.
   - no phone → `422 no_phone`;
   - premium number → `422 premium`.
   Then **3 per day per phone number** (`phone_verifications`), which needs the number → `429 too_many_attempts`.
7. Start the verifier (`worker/phone.ts`):

   ```ts
   interface PhoneVerifier {
     kind: 'call' | 'screen';
     start(e164: string): Promise<{ ref: string; devCode?: string }>;
     check(ref: string, e164: string, code: string): Promise<'approved' | 'pending' | 'expired' | 'max_attempts'>;
   }
   ```

   **Twilio** (mainnet; `worker/twilio.ts`, fully implemented and unit-tested with a fake `fetch`):
   - Start: `POST https://verify.twilio.com/v2/Services/{TWILIO_VERIFY_SID}/Verifications` with form fields
     `To=<E.164>&Channel=call&Locale=en`.
   - Check: `POST …/VerificationCheck` with `To=…&Code=…`. `status:'approved'` means approved.
   - Both use Basic auth with `base64(SID:TOKEN)` and a 10 s timeout.
   - Error mapping: Twilio 60203 (max sends) and 60202 (max checks) → `too_many_attempts`; 60410 (fraud block) and
     60605 (geo blocked) → `premium` ("We can't call this number"); 20404 on check → expired; anything else →
     `upstream`.
   - `/api/health` reads `GET https://verify.twilio.com/v2/Services/{sid}` and reports `phone:'mismatch'` unless
     `code_length === 6`.
   - Twilio errors are never forwarded raw.

   **Screen** (devnet; `worker/dev/screenVerifier.ts`, compiled only with `__CS_DEV_ENDPOINTS__`):
   - Generates the 6 digits with `crypto.getRandomValues` and stores `code_hash = HMAC('code:'+claimId+code)`.
   - Returns `devCode`. It never calls anyone.
8. Insert the claim (`status:'calling'`, `expires_at = now + 10 min`) and respond with `ClaimCallResponse`.

**`/api/claim/check`.**

- A wrong code returns `{approved:false, attemptsLeft}`. After the third wrong code the claim moves to `failed` and
  `attemptsLeft` is 0.
- An approved code sets `status='verified'` and issues `claimToken` = random 32 bytes base64url. Only
  `token_hash = HMAC('tok:'+token)` is stored, and the token expires after 30 min.

**`/api/claim/cosign`:**

1. The claim is `verified` or `cosigned`, the token matches and has not expired, and `cosign_count < 5`.
2. The first call binds `new_owner`. A later call with a different key → `422 wrong_owner`.
3. Read VaultState: `has_pending === 0`, otherwise `409 claim_pending`; `owner === newOwner` → `409 already_owner`.
   Set `expectedNonce = claim_nonce + 1`.
4. Decode the message and require the canonical re-serialize (as for launches). Then
   `checkClaimMessage(msg, {attestor, newOwner, placeId, expectedNonce})` with no relayer in v1 (fee payer = new owner).
   Any violation → `422 policy_violation`.
5. Sign and set `status='cosigned'`. Send the owner alert `owner_cosign` (`warn`, once a day per place, nonce and
   wallet): every on-chain `request_claim` needs this co-sign, and the claimant may send it without ever calling
   `/confirm`.

**`/api/claim/confirm`.**

- Verify the tx landed, and that VaultState `pending_owner === new_owner` and `claim_nonce === nonce`.
- Set `status='pending_onchain'`, `unlock_ts`, `in_probation`. Respond with
  `{status:'pending_onchain', unlockTs, inProbation, claimWindowSecs}`.

**`/api/claim/website`** (P1):

1. The host must be the Google `websiteUri` host, looked up server-side, and must pass `isOwnSiteHost`
   (`worker/website.ts`: not a platform host, not a bare public suffix). Otherwise `422 not_own_domain`. The lookup
   is a paid call (never cached), so it comes after the caps: 10 new codes a day per network (`website:ip:*`), 20 per
   shop (`website:place:*`), then the global Google budget (`google:global`). A request refused before Google is
   called uses none of them up.
2. Issue the code `atlaspad-verify=XXXX-XXXX`.
3. On a check, fetch `https://<host>/.well-known/atlaspad.txt`, then the legacy
   `https://<host>/.well-known/cornershop.txt`, then `https://<host>/` (`worker/website.ts` `findOwnershipProof`):
   - HTTPS only, 5 s timeout, ≤ 512 KB;
   - redirects only within the same registrable domain (on a multi-tenant host such as `github.io`, `netlify.app` or
     `myshopify.com`, `MULTI_TENANT_SUFFIXES` in `worker/website.ts`, that is the same customer's subdomain; the bare
     platform host is never a business's own site);
   - no IP literals or private ranges (reuse the SSRF rules from `/api/resolve`).
4. Only places the site owner controls count (round-1 security fix): a well-known file served as plain text (not HTML)
   with the code as a whole line (with or without its `atlaspad-verify=` label), or
   `<meta name="atlaspad-verify" content="XXXX-XXXX">` inside the home page's `<head>` (scripts, styles, comments and
   templates stripped first). The CORNERSHOP-era `cornershop-verify` tag and `cornershop.txt` stay accepted. Tag and
   file names live in `worker/siteMarker.ts`, shared with the claim UI. The code anywhere else (reviews, comments,
   guestbooks) never approves.
5. When the code is found → `approved` with a `claimToken`, plus a `warn` alert `claim_website_verified` (sent to
   `ALERT_EMAIL_TO` / `ALERT_WEBHOOK_URL`); at the co-sign, `owner_cosign`; when such a claim goes pending on-chain, the
   owner alert `owner_claim` (`warn`: "needs a human check before unlock"; a weaker proof than the listing's phone: the
   guardian reviews it before the window ends). A pending claim that never went through `/confirm` is still reported:
   by the program monitor, and by the vault sweep (`claim_pending_onchain`; each pass of the sweep reads every coin,
   8-32 coins a cron run, and a new pass starts at most every 10 min). The sweep judges it by the claims rows, not the
   coins mirror (which a public `?fresh=1` read also writes): `warn` when the site co-signed it more than 10 min ago
   and no confirm came, `critical` when it never co-signed it. A website on a multi-tenant host is flagged in
   `claim_website_verified`, `owner_cosign` and `owner_claim` ("check the subdomain is the business's own"): anyone
   can sign up for one there.

**Email-at-domain** has no real-mode backend this round. The UI shows the card disabled with "Not available yet".

### 3.6 `POST /api/rpc` (JSON-RPC proxy)

- Accepts a single request or a batch of ≤ `RPC_LIMITS.batchMax` (10). The method must be in `RPC_METHODS`; otherwise
  the response is the JSON-RPC error `{code:-32601, message:'method not allowed'}`.
- **Parameter rules** (a violation returns `-32602`):

  | Method | Rule |
  |---|---|
  | `getAccountInfo` / `getMultipleAccounts` | `encoding` is `base64` or `jsonParsed`; `dataSlice` allowed; ≤ 100 keys |
  | `getSignatureStatuses` | ≤ 50 signatures; `searchTransactionHistory` must be false |
  | `getSignaturesForAddress` | `limit` ≤ 25 |
  | `getTransaction` | `maxSupportedTransactionVersion: 0`; `encoding` is `json`, `jsonParsed` or `base64` |
  | `sendTransaction` | `encoding: 'base64'`; the decoded length is ≤ 1,232 B; `maxRetries` ≤ 5; `skipPreflight` allowed |
  | `simulateTransaction` | ≤ 1,232 B; `accounts.addresses` ≤ 10 |
  | `getTokenAccountsByOwner` | the filter is `{mint}` or `{programId}` ∈ {SPL Token, Token-2022} |

- **Shared caches (per isolate).** `getLatestBlockhash` and `getBlockHeight` 1 s · `getGenesisHash` and
  `getMinimumBalanceForRentExemption` forever · `getAccountInfo`/`getMultipleAccounts` 1 s, keyed by request.
- **Response.** The `result` or `error` object is re-serialized as `{jsonrpc:'2.0', id, result|error}`. A non-JSON or
  HTTP ≥ 400 upstream response becomes `{code:-32000, message:'upstream unavailable'}`. Bodies over 1 MB become
  `-32000 'response too large'`.
- **Timeouts.** 10 s for reads, 15 s for `sendTransaction`. One retry with jitter on 429/5xx for reads only. Never
  retry `sendTransaction`; the client rebroadcasts.
- **Rate limits.** RL_RPC per IP (IPv6 per /64) for everything, plus RL_SEND for `sendTransaction`/`simulateTransaction`
  (mainnet: RL_RPC 200 and RL_SEND 15 per 60 s; devnet 300/30). On mainnet, send/simulate are refused (-32602
  'not an AtlasPad transaction') unless the transaction names the shop-vault, pump or pump-amm program. HTTP 429
  carries the JSON-RPC error `-32005`.
- **Sanctions.** A `sendTransaction` whose bytes contain an address on the OFAC list (`worker/sanctions.ts`; fee payer,
  accounts or instruction data, found by a raw byte scan) is answered `-32051 'wallet blocked'` (`RPC_WALLET_BLOCKED`)
  and never relayed.

### 3.7 Indexer (`scheduled()` every minute, plus on demand)

**Lock.** `kv_meta.indexer_lock` is taken with a conditional UPDATE (expires after 50 s). Then the budget applies:
≤ 40 fetches, ≤ 40 D1 statements (batched), and a stop at 25 s wall time, with leftover work carried to the next run.
On-demand entry points (`/api/index/tx`, `/api/launch/confirm`, opportunistic `/api/market`) call the same functions
with a 10-fetch budget.

| Every | Job |
|---|---|
| 1 min | SOL/USD (§1.8) · on-chain Config (paused, attestor, window, probation) · pump Global (10 min) · priority fee (mainnet: `getRecentPrioritizationFees` (standard RPC) on the pump program accounts, clamped to [1,000, 2,000,000] µL; devnet: `PRIORITY_FEE_DEFAULT`) |
| 1 min | **Curves sweep, hot coins.** Hot = traded in the last 6 h or created in the last 24 h. `getMultipleAccounts` over bonding curves in chunks of 100 → update `v_sol…progress_pct`, `market_slot`. Mark a coin dirty when `real_sol` changed or the cursor is ≥ 10 min old |
| 1 min | **Trades backfill, dirty coins.** `getSignaturesForAddress(bonding_curve, {until: cursor, limit: 25})` → `getTransaction` (JSON-RPC batch ≤ 10) → decode events → `INSERT OR IGNORE trades` → advance the cursor. ≤ 30 transactions per run |
| 1 min | Reservation reconciliation (§3.4) · claims: `pending_onchain` with `unlock_ts ≤ now` → `finalize_claim` tx (fee payer CRANK; simulate first) → `finalized`; `calling` past `expires_at`, and `verified`/`cosigned` past `token_expires_at` → `expired` (this frees the one-active-claim index) |
| 1 min | **Program monitor** (P1). `getSignaturesForAddress(PROGRAM_ID, {until})` → decode `Program data:` log segments (SPEC §7: segment 0 = ASCII name) → `chain_events`. Alerts: every `AdminChanged` without a matching `admin_expectations` row (critical) · `Registered` without a coin or reservation (critical: possible attestor misuse) · `ClaimRequested` without a claims row (critical) · `ClaimCancelled` (warn). Delivered to `alerts` and to `ALERT_EMAIL_TO` / `ALERT_WEBHOOK_URL` (worker/notify.ts). A `ClaimRequested` with a claims row sends the owner alert (one per claim, shared with claim confirm) |
| 10 min | Curves sweep for every coin · vault sweep for every coin: `getMultipleAccounts([vault, vault_state, pumpCreatorVault(vault), vaultWsolAta(vault)(, ammCreatorVaultAta)])`, 4–5 keys per coin → `feesWaiting()` (shop-vault client) with rent minimums from `getMinimumBalanceForRentExemption(0 / 208 / 165)` → `fees_*`, `owner…`, `claim_nonce`. Alert `critical` when `curve.creator ≠ vault` (pump `admin_cto`, SPEC §8.5) · 24 h aggregates (`vol24h_lamports`, `change24h_pct`) for coins that traded · graduation (P1): `complete=1` → canonical pool `canonicalPumpPoolPda(mint)` = PDA(`["pool", u16le(0), PDA(["pool-authority", mint], pump), mint, WSOL]`, pump-amm). If the account exists, set `graduated=1`, `pool`, `pool_base_vault` (@139) and `pool_quote_vault` (@171), and index AMM trades via `getSignaturesForAddress(pool)` from then on |
| 10 min | Coordinate refresh (P1): coins with `coords_expire_at < now + 3 d`, ≤ 20 per run, Places (New) `X-Goog-FieldMask: location` |
| every run + 60 min | Holders: coins that traded since their last count (≤ 4 per run) plus the hourly sweep (≤ 10). `getTokenLargestAccounts(mint)` (standard RPC, every Alchemy plan) → count `amount > 0`, excluding the curve ATA and the pool base vault: exact below 20 token accounts; from 20 on, max(that, holders derived from D1 trades: net bought − sold per trader > 0) |
| 6 h per coin | Fee crank (P1): if `collectable ≥ 0.01 SOL` → tx `[sweep_creator_fee if bucket > 0] [pump_amm transfer_creator_fees_to_pump if graduated] collect_creator_fee(creator = vault)`, fee payer CRANK. BACKEND hand-encodes these in `worker/pumpIx.ts` (IDL 3.2.0 account lists). A unit test compares them with the SDK builders' account metas (the SDK is a devDependency only; never bundle it in the Worker). Keeps fees out of pump's reach (SPEC T13) |

**Event decoding** (pump uses Anchor event-CPI). A trade event is an inner instruction whose data (base58 in `json`
encoding) starts with the tag `e445a52e51cb9a1d` followed by the 8-byte event discriminator. Offsets below are relative
to the start of the event body, after both 8-byte prefixes.

- **pump `TradeEvent`** (`bddb7fd34ee661ee`):

  | Offset | Field | Offset | Field |
  |---:|---|---:|---|
  | 0 | mint | 89 | virtual_sol_reserves |
  | 32 | sol_amount | 97 | virtual_token_reserves |
  | 40 | token_amount | 105 | real_sol_reserves |
  | 48 | is_buy | 113 | real_token_reserves |
  | 49 | user | 169 | creator |
  | 81 | timestamp (i64, s) | 209 | creator_fee |

  - Keep the event only when `mint` is a registered coin.
  - `price_lamports = virtual_sol_reserves × 10^6 / virtual_token_reserves`.
  - `sol_amount` is the curve-side amount, before fees.
  - `ts = timestamp × 1000`; fall back to `blockTime`.
- **pump-amm `BuyEvent`** (`67f4521f2cf57777`):

  | Offset | Field |
  |---:|---|
  | 0 | timestamp |
  | 8 | base_amount_out |
  | 104 | user_quote_amount_in |
  | 112 | pool |
  | 144 | user |
  | 344 | coin_creator_fee |

- **pump-amm `SellEvent`** (`3e2f370aa503dc2a`):

  | Offset | Field |
  |---:|---|
  | 8 | base_amount_in |
  | 104 | user_quote_amount_out |
  | 112 | pool |
  | 144 | user |
  | 344 | coin_creator_fee |

  For AMM trades, `price_lamports` is the execution price: `quote × 10^6 / base`.
- Other useful events: pump `CompleteEvent` (`5f72619cd42e9808`, graduation), `AdminCtoEvent` and `SetCreatorEvent`
  (critical alert for our mints).

**Without the cron** (account limit hit), the same jobs run from `ctx.waitUntil` on `/api/market` and `/api/feed`
requests, gated by `kv_meta.indexer_last_run < now − 60 s`.

### 3.8 `/api/dev/airdrop` (devnet only)

The route is compiled only with `__CS_DEV_ENDPOINTS__`. At runtime it also requires `env.CLUSTER === 'devnet'`, the
devnet genesis hash and `DEV_FAUCET_SECRET`; otherwise `404 not_enabled`.

- It sends `min(1 SOL, remaining caps)` from the faucet key to `address`, a System transfer built and signed in the
  Worker.
- It runs only when the address balance is below 1 SOL.
- Caps (D1): 2 SOL per day per address · 3 SOL per day per IP · 30 SOL per day overall → otherwise `429 faucet_cap`.
  Each cap is reserved atomically (conditional UPSERT) before the transfer is sent and released if nothing was sent.
- After every payout (and on a `faucet_empty` refusal) `kv_meta.faucet_balance` is updated, so `/api/config`
  `features.faucet` and `/api/health` `faucet` follow the real balance.
- Payout = min(1 SOL, the caps, half of what the faucet can spend (balance − 0.05 SOL), but ≥ 0.25 SOL). If the faucet holds less than 0.3 SOL → `503 faucet_empty`. RUNBOOK covers refilling it (round 2: the public devnet airdrop is dry; a low faucet still serves the next testers).
- It returns after `confirmed`.

### 3.9 `/api/health`

Reports `HealthResponse` checks without secret values. `ok` is true when google, alchemy, genesis, program, config,
attestor, alt, d1 and priceFeed are all `ok`, and the indexer is not `stale`. `scripts/smoke.mjs` asserts this.
The RPC check is named `alchemy` (the old `helius` name is gone). The chain reads are shared per isolate for 15 s
(Google 10 min, Twilio 5 min), so public traffic on this uncached route cannot burn the RPC quota. Devnet `faucet` is
`ok` only at ≥ 0.3 SOL (the payout floor), else `stale` (smoke warns).

---

## 4. Chain layer (CHAIN: `src/chain`, `src/wallet/solanaWallets.ts`, `src/dev`)

### 4.1 Modules

**Light modules** may be imported statically anywhere: no web3.js, no SDK, each ≤ 6 KB gz.

| File | Exports |
|---|---|
| `types.ts` | the contract types |
| `curve.ts` | **Worker-safe, pure.** `decodeBondingCurve(data: Uint8Array): CurveState`, `curvePrice(c): PriceView` (`initialRealTokenReserves` from config for `progressPct`), `poolPrice(baseAmount, quoteAmount, virtualQuote?)`, `mcapLamports(c)` |
| `amounts.ts` | `parseSol(text): bigint \| null` (string → lamports, ≤ 9 dp, no floats), `parseTokens(text, decimals = 6)`, `formatLamports`, `lamportsToSol(n): number` (display only) |
| `explorer.ts` | `explorerTx(sig)`, `explorerAddress(a)`, `explorerToken(mint)` (Solscan, plus `?cluster=devnet` on devnet, from `CLUSTER`) |
| `rpc.ts` | `rpc<T>(method, params)` over `fetch('/api/rpc')`, `getMultipleAccountsRaw(keys): Promise<({lamports, owner, data: Uint8Array} \| null)[]>`, `getBalance(addr): Promise<bigint>`, `getToken2022Holdings(owner): Promise<Holding[]>` (decodes mint@0 and amount@64 from base64) |
| `load.ts` | `loadChain(): Promise<typeof import('./index')>` (memoised dynamic import) · `prefetchChain()` (on `requestIdleCallback`) · `prefetchPump()` |

**Heavy modules** (`index.ts` and everything it imports) are reached only through `loadChain()`. They pull in
`@solana/web3.js`, `@cornershop/shop-vault-client` and `@pump-fun/pump-sdk`. The pump SDK must stay in its own chunk,
which `check-bundle` asserts. The AMM code (`amm.ts`, `@pump-fun/pump-swap-sdk`) is a further dynamic import, loaded only
for graduated coins. `polyfills.ts` sets `globalThis.Buffer ??= Buffer` (from `buffer`) and is the first import of
`index.ts`.

### 4.2 API (`src/chain/index.ts`)

```ts
export function initChain(cfg: ConfigResponse): void;                 // once, after /api/config
export function connection(): Connection;                              // web3 Connection via /api/rpc (§1.7)

export function estimateLaunchCost(devBuyLamports: bigint): Promise<LaunchCostEstimate>;
export function launchCoin(input: LaunchInput, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<LaunchValue>>;

export function quoteBuy(mint: string, lamportsIn: bigint, slippageBps?: number): Promise<BuyQuote>;  // default 200 bps
export function quoteSell(mint: string, tokensIn: bigint, slippageBps?: number): Promise<SellQuote>;
export function buy(q: BuyQuote, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<TradeFill>>;
export function sell(q: SellQuote, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<TradeFill>>;

export function getVault(placeId: string): Promise<VaultView>;
export function requestClaim(a: { placeId: string; claimId: string; claimToken: string }, signer: WalletSigner,
                             onProgress: OnProgress): Promise<TxOutcome<ClaimRequestValue>>;
export function finalizeClaim(placeId: string, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<void>>;
export function collectAndWithdraw(placeId: string, signer: WalletSigner, onProgress: OnProgress, mint?: string,
                                   opts?: { acceptLoss?: boolean }): Promise<TxOutcome<WithdrawValue>>;
// WithdrawValue = { lamports (received), withdrawnLamports (vault payout), feeLamports (what the tx cost the owner) }

export function toTxError(e: unknown, ctx: { sent: boolean; signature?: string; walletName?: string }): TxError;
export const MAX_PRICE_IMPACT_PCT = 15;
```

Every function that signs calls `assertRealMode()` first. The functions **never throw** for expected failures; they
return `{ok:false, error}`. Network calls go to `/api/*` only, through `src/chain/api.ts` (typed with `worker/wire.ts`).

### 4.3 Curve math (exact; shared with the Worker)

The BondingCurve account offsets **include** the 8-byte discriminator `17b7f83760d8ac60`:

| Offset | Field | Offset | Field |
|---:|---|---:|---|
| 8 | virtual_token_reserves | 49 | creator |
| 16 | virtual_quote_reserves | 81 | is_mayhem_mode |
| 24 | real_token_reserves | 82 | is_cashback_coin |
| 32 | real_quote_reserves | 83 | quote_mint |
| 40 | token_total_supply | 124 | is_holder_reward |
| 48 | complete | 125 | creator_fee (bucket; 0 if the account is shorter) |
| | | 142 | initial_virtual_quote_reserves |

- `lamportsPerToken = Number(vQuote × 10^6 × 10^6 / vToken) / 10^6`. Compute in bigint with 6 extra digits, then
  convert once.
- `mcapLamports = vQuote × tokenTotalSupply / vToken`. This is `bondingCurveMarketCap` in the pump SDK; integer division.
- `progressPct = clamp(0, 100, (initialRealTokenReserves − realTokenReserves) × 100 / initialRealTokenReserves)`, and
  100 when `complete`.
- AMM: `lamportsPerToken = (quoteVault + poolVirtualQuote) × 10^6 / baseVault`. Include `Pool.virtual_quote_reserves`
  only when it is non-zero. CHAIN verifies this against `@pump-fun/pump-swap-sdk` quotes on devnet after graduation and
  documents the result in a comment.
- **Trade quotes always use the SDK on fresh state** (`OnlinePumpSdk.fetchBuyState/fetchSellState` over `connection()`,
  Global and FeeConfig cached for 60 s):
  - curve buys: `getBuyV3TokenAmountFromQuoteAmount({global, feeConfig, mintSupply, bondingCurve, amount, curveBaseTokenBalance})`;
  - sells: `getSellSolAmountFromTokenAmount`.

  These include the fee tiers. `priceImpactPct = (priceAfter − priceBefore) / priceBefore × 100`. Refuse to send when it
  is above `MAX_PRICE_IMPACT_PCT` (error `price-impact`).

### 4.4 Launch transaction (must pass `checkLaunchMessage` byte for byte)

`launchCoin` performs these steps, in this order:

1. **Metadata** (`step:'metadata'`): POST `/api/metadata`.
2. **Mint**: `Keypair.generate()`, kept in memory only.
3. **Prepare** (`step:'prepare'`): POST `/api/launch/prepare`.
4. **Build** a v0 message, payer = launcher, recent blockhash from prepare, with the instructions in exactly this order:

   ```text
   0 ComputeBudget.setComputeUnitLimit(prep.computeUnitLimit /* 400_000 */)
   1 ComputeBudget.setComputeUnitPrice(prep.priorityFeeMicroLamports)
   2 sdk.createV2Instruction({ mint, name: prep.name, symbol: prep.symbol, uri: prep.uri, creator: prep.vault,
                               user: launcher, mayhemMode: false })
   3 sv.registerLaunch({ launcher, attestor: prep.attestor, placeHash: fromHex(prep.placeHash), mint })
   // only when devBuyLamports > 0:
   4 createAssociatedTokenAccountIdempotentInstruction(launcher, ATA(launcher, mint, TOKEN_2022), launcher, mint, TOKEN_2022)
   5 sdk.getBuyExactQuoteInV3InstructionRaw({ user: launcher, mint, spendableQuoteIn: BN(devBuy), minTokensOut: BN(1),
                                             buybackFeeRecipient: 5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD })
   ```

   Then `compileToV0Message([altAccount])`. The ALT account comes from `connection().getAddressLookupTable(prep.alt)`
   and is cached for the session. `minTokensOut = 1` is safe because `register_launch` proves the curve is untraded
   (SPEC §8.1). Assert the serialized size is ≤ 1,232 B before sending anything.
5. **Cosign** (`step:'cosign'`): POST `/api/launch/cosign` → `tx.addSignature(attestor, sig)` → `tx.sign([mintKeypair])`.
6. **Simulate** (`step:'simulate'`): `simulateTransaction(tx, { sigVerify: false, commitment: 'processed' })`. Map
   errors before the wallet opens:
   - 110 `AlreadyRegistered` → `taken`;
   - 109 → `paused`;
   - insufficient lamports → `insufficient-sol`.
7. **Sign** (§4.7, `phase:'awaiting-signature'`) → **send and confirm** → `phase:'registering'` → POST
   `/api/launch/confirm` (retry while it answers 202, every 1.5 s for up to 30 s).
8. **Result.** Parse the dev-buy `TradeEvent` from the confirmed tx (`getTransaction` through the proxy) →
   `devBuy: TradeFill`, or the quote with `estimated: true` if parsing fails.

Retry policy:

- **Blockhash expired:** reuse the reservation if it is still valid (re-cosign up to 5 times). Otherwise run prepare
  again with a **new** mint.
- **Rejected in the wallet:** release nothing. The reservation simply expires.

### 4.5 Trades

**Curve (pre-graduation):**

- Buy: `sdk.buyExactQuoteInV3Instructions({ bondingCurve, associatedUserAccountInfo, mint, user, amount: quote.tokensOut,
  quoteAmount: lamportsIn, slippage: slippageBps/100, tokenProgram: TOKEN_2022, buybackFeeRecipient: BUYBACK })`.
- Sell: `sdk.sellV3Instructions({ …, amount: tokensIn, quoteAmount: quote.lamportsOut, slippage, tokenProgram:
  TOKEN_2022, buybackFeeRecipient: BUYBACK })`.
- Add the compute budget (CU limit 200k, price from config).
- **A "100%" sell uses the exact raw holding** (bigint), never a float.

**Graduated coins (P1).** `@pump-fun/pump-swap-sdk@2.1.0` builds buy and sell directly on the canonical pool, **on both
clusters**. This is a deliberate deviation from "Jupiter after graduation": Jupiter has no devnet, so the mainnet path
could not be tested. Since pump coins' liquidity sits in the canonical pool, direct quotes are exact. The Jupiter Swap
API (`/swap/v2/order` through a Worker route) is a mainnet-only P2 fallback behind `features.jupiter`.

**Curve completes mid-trade.** If the curve completes between the quote and the send, pump error 6005
`BondingCurveComplete` maps to `graduated`: "This coin just graduated. Try again in a minute." The UI then refreshes the
market data.

**After success:**

- Parse `TradeEvent`/`BuyEvent`/`SellEvent` from the tx → `TradeFill`.
- `POST /api/index/tx {signature}` so the feed shows the trade within about 2 s.
- The caller (APP) calls `refreshAfterTx`.

### 4.6 Vault, claims, withdraw

- **`getVault(placeId)`.** One `getMultipleAccounts([vault_state, vault, pumpCreatorVault(vault), bondingCurve,
  vaultWsolAta(vault)])` → `decodeVaultState` + `feesWaiting()` (client). Rent minimums come from the proxy and are
  cached. This gives the exact lamports for the owner panel and the claim modal.
- **`requestClaim`.**
  - Tx: `[setComputeUnitLimit(6_300), setComputeUnitPrice] + sv.requestClaim({attestor, newOwner: signer.address,
    placeHash, nonce: claimNonce + 1n})`. Vault operations (claim, finalize, withdraw, the Worker's crank) take their
    CU limits and priority from `src/chain/budget.ts`: per-instruction budgets from measurements (~1.5× the most seen),
    and the cluster price capped so the priority part never exceeds 0.00002 SOL per tx (they race nobody).
  - No ALT; fee payer = the new owner.
  - Then cosign (`/api/claim/cosign`) → sign → send → confirm → `/api/claim/confirm`.
- **`finalizeClaim`** (anyone, once `now ≥ unlockTs`): `sv.finalizeClaim({placeHash})`, fee payer = the signer.
- **`collectAndWithdraw`** (owner only), SPEC §8.3 in one tx:

  ```text
  [sweep_creator_fee if bucket > 0] [pump_amm transfer_creator_fees_to_pump if graduated]
  [collect_creator_fee(creator = vault)] [sv.unwrapWsol if the vault WSOL ATA exists] sv.withdraw({owner, placeHash})
  ```

  Use the SDK builders for the pump steps. If the result exceeds 1,232 B, drop the optional steps in order. Result =
  the owner's lamport delta from the tx meta, the vault payout (`Withdrawn` event) and what the tx cost the owner;
  the toast reads `Withdrew 0.0063 SOL to BMAo…8JhM · network fee 0.000012 SOL`, never `Withdrew 0 SOL`.
  When `VaultView.withdrawCostLamports` ≥ `fees.total` the call is refused before signing (`uneconomic`) and the UI
  disables Withdraw with `Network fee ≈ X SOL is more than the Y SOL waiting. Withdrawing now would cost you more than
  you receive.` (`acceptLoss` skips the check for tests and scripts only).

### 4.7 Signing, sending, confirming (`src/chain/send.ts`)

1. **Sign.** `phase:'awaiting-signature'` with `walletName` → `signer.signTransaction(tx.serialize())` →
   `VersionedTransaction.deserialize(out)`.
2. **The message must be byte-identical** to the one we built and co-signed. Otherwise return the error
   `wallet-modified` and do not send. Re-apply the attestor and mint signatures if the wallet dropped them; they are
   still valid on the same message.
3. **Send.** `phase:'sending'` → `sendTransaction(base64, {encoding:'base64', skipPreflight: true, maxRetries: 0})`.
   Preflight is skipped because we simulated already; this saves about 300 ms. Read the signature from
   `tx.signatures[0]` (base58) before sending, so `TxError.signature` exists even if the send call times out.
4. **Confirm.** `phase:'confirming'`. Every 800 ms:
   - `getSignatureStatuses([sig])`; done at `confirmed`/`finalized` with `err == null`;
   - rebroadcast the same bytes every 2 s;
   - stop when `getBlockHeight() > lastValidBlockHeight` → `expired`, with `sent: true` and the copy "It didn't go through
     in time. Nothing was charged.";
   - hard cap 60 s → `unconfirmed`, with an explorer link.

   `onProgress` reports `elapsedMs` every second. Never call `confirmTransaction` (it needs WebSockets).
5. **Explorer link.** Every outcome carries `explorerUrl` (`explorerTx(sig)`).

### 4.8 Error mapping (`toTxError`; messages are final copy)

| Condition | code | message (retryable?) |
|---|---|---|
| Wallet error 4001 / "User rejected" / `WalletSignTransactionError` with reject | `rejected` | `You cancelled in {Wallet}.` (no) |
| Simulation/landed: `InsufficientFundsForFee`, `insufficient lamports`, System error 1, pump 6040/6041 | `insufficient-sol` | `Not enough SOL. You need about {x} SOL.` (no; show the faucet on devnet) |
| pump 6023 / AMM `ZeroBaseAmount` on a sell | `insufficient-tokens` | `You don't hold that many $TICKER.` (no) |
| pump 6002/6003/6042, AMM 6004/6040 | `slippage` | `The price moved. Try again.` (yes) |
| Quote impact > 15% | `price-impact` | `That trade would move the price more than 15%. Try a smaller amount.` (no) |
| Blockhash not found / block height exceeded | `expired` | `It didn't go through in time. Nothing was charged. Try again.` (yes) |
| shop-vault 110 `AlreadyRegistered`, or API 409 `taken` | `taken` | (the DESIGN "Someone launched this shop first" screen) |
| API 409 `reserved` | `reserved` | `Someone else is launching this shop right now. Try again in a minute.` (yes) |
| shop-vault 109 / API 423 | `paused` | `Launches are paused right now. Trading and claims still work.` (no) |
| pump 6005 | `graduated` | `This coin just graduated. Try again in a minute.` (yes) |
| API 422 `policy_violation` | `policy` | `We couldn't approve this transaction. Please try again.` (yes; log `violations` to the console in devnet only) |
| Message changed after signing | `wallet-modified` | `Your wallet changed the transaction, so it can't be sent. Try again, or use another wallet.` (yes) |
| No `solana:signTransaction` | `wallet-unsupported` | `This wallet can't sign here. Try Phantom, Solflare or Backpack.` (no) |
| HTTP 429 / RPC -32005 | `rate-limited` | `Too many requests. Wait a few seconds and try again.` (yes) |
| API 451 `place_region_blocked` | `not-launchable` | `AtlasPad isn't available for businesses in this region.` (no) |
| API 451 `wallet_blocked` / RPC -32051 | `unknown` | `This wallet can't be used on AtlasPad.` (no) |
| `fetch` failed or 5xx before sending | `network` | `We couldn't reach the network. Nothing was sent.` (yes) |
| Sent, no status after 60 s | `unconfirmed` | `We couldn't confirm it yet. Check the explorer.` (no; show the link) |
| Landed with any other program error | `onchain` | `The transaction failed on Solana. Nothing changed.` (yes) |
| Withdraw whose estimated cost (`withdrawCostLamports`) ≥ the fees waiting; refused before signing | `uneconomic` | `The network fee is more than the fees waiting. Withdrawing now would cost you more than you receive.` (no) |

**Decode `InstructionError: [i, {Custom: n}]`** using the program at instruction `i`: shop-vault codes 100–139 (client
`parseShopVaultError`), pump 6000+, pump-amm 6000+, System 0–8. **Never** write "nothing was sent" after a signature
exists (`sent: true`).

### 4.9 Wallet signing (`src/wallet/solanaWallets.ts`, CHAIN)

- New export `getSigner(): WalletSigner | null`. It wraps the connected Wallet Standard wallet's `solana:signTransaction`
  feature: `{account, transaction: bytes, chain: \`solana:${CLUSTER}\`}` → `signedTransaction`. It also wraps
  `solana:signMessage` when present.
- It returns null when there is no connected standard wallet, or when the wallet is the mocked email wallet.
- `assertRealMode('Signing')` runs inside `getSigner`. **Demo mode still touches only `standard:connect`,
  `standard:disconnect` and `standard:events`.** Keep the SAFETY header and extend it.
- The wallet list in real mode accepts wallets whose `chains` include `solana:${CLUSTER}`, or any `solana:*` chain. The
  devnet test wallet is pinned first on devnet.

---

## 5. Real data layer (APP: `src/realdata`)

### 5.1 Contract

```ts
// src/realdata/index.ts
export function startRealData(): () => void;      // App calls this in real mode INSTEAD of startSimulator; returns cleanup
export function refreshAfterTx(kind: 'launch' | 'trade' | 'claim' | 'withdraw', mint?: string): Promise<void>;
export function ensurePlace(placeId: string): Promise<PlaceResponse>;        // place panel: coin or launchable?
export function checkEligibility(placeId: string): Promise<EligibilityResponse>;
// src/realdata/api.ts  — typed fetchers for every GET in §3.1 (ApiError {status, body: ApiErrorBody})
// src/realdata/mapping.ts — coinFromDTO(dto, solUsd): Coin · tradeFromDTO · feedEventFromDTO
```

In real mode, **App never imports `src/data/**`** (`mockCoins`, `simulator`, `fictional`). Demo mode loads them through a
dynamic `import()`, which keeps them out of the real-mode initial chunk.

### 5.2 Polling (all paused while `document.visibilityState === 'hidden'` or offline; an immediate poll on resume)

| Data | Source | When |
|---|---|---|
| Config + SOL/USD | `GET /api/config` | boot, then every 60 s |
| Registry for the viewport | `GET /api/coins?bbox` (snapped 0.01°) | viewport idle + 300 ms debounce, skipped when a covering bbox was fetched < 30 s ago. Below zoom 11: `GET /api/top?by=mcap&limit=300` |
| Prices: visible + selected coins (≤ 100, by mcap) | `GET /api/market?mints=` | every **5 s** |
| Selected coin detail | `GET /api/coins/:mint` | on select, every 15 s while selected, `?fresh=1` after an own tx |
| Feed | `GET /api/feed?since=` | every 5 s while Live (or This area) is open, otherwise every 20 s |
| Top shops | `GET /api/top` | when the panel opens, then every 30 s |
| My coins | `GET /api/coins?launcher=&owner=` + holdings | panel open, after own txs |
| Wallet SOL balance + holdings | `src/chain/rpc.ts` `getBalance` + `getToken2022Holdings` → `GET /api/coins?mints=` for unknown mints | connect, after each own tx (immediately and again after 3 s), every 30 s while the trade box, My coins or the account menu is open |

**Pin flashes** come from market deltas. When `realSol` rises between two polls, flash
`+{Δ SOL}` (buy); when it falls, `−{Δ SOL}`. The amount is the net over the 5 s window. Feed rows still come from
`/api/feed`.

### 5.3 Store mapping (APP owns `src/store.ts` / `src/types.ts`)

New state:

- `chain: { status: 'off' | 'loading' | 'ready' | 'mismatch' | 'error'; config: ConfigResponse | null }`;
- `tx: { kind: 'launch'|'buy'|'sell'|'claim'|'finalize'|'withdraw'; placeId; progress: TxProgress | null; error: TxError | null } | null`;
- `holdingsRaw: Record<placeId, string>` (base units, for exact sells).

`Coin` additions (all optional, so demo coins are unchanged):

- `real?: { feesWaitingLamports: string; feesWithdrawnLamports: string; ownerStatus: 'unclaimed'|'pending'|'claimed';
  unlockTs: number|null; inProbation: boolean; graduated: boolean; progressPct: number; imageUrl: string|null;
  change24hKnown: boolean; holdersKnown: boolean; marketAt: number }`.

`coinFromDTO` (USD = SOL × `solUsd` from the **same** response):

| Coin field | From |
|---|---|
| `priceSol` | `market.priceLamports / 1e9` |
| `priceUsd` | `priceSol × solUsd` |
| `marketCapUsd` | `mcapLamports / 1e9 × solUsd` |
| `supply` | `supply / 1e6` |
| `volume24h` | `vol24hLamports / 1e9 × solUsd` |
| `change24h` | `change24hPct ?? 0` (shown as `—` when `!change24hKnown`) |
| `holders` | `holders ?? 0` (shown as `—` when `!holdersKnown`) |
| `feesEarnedUsd` | `fees.earnedLamports` → USD |
| `feesClaimedUsd` | `fees.withdrawnLamports` → USD |
| fees waiting (everywhere) | `fees.waitingLamports` → USD, with SOL secondary |
| `claimed` / `ownerVerified` | `owner.status === 'claimed'` |
| `claimPending` | `owner.status === 'pending'` |
| `owner` / `payoutWallet` | `owner.owner` |
| `logo` | `imageUrl ? {kind:'upload', dataUrl: imageUrl, emoji, bg} : {kind:'sticker', emoji, bg}` |
| `place` | `{id: placeId, source: 'google', location: dto.location ?? lastKnown, category, emoji}` |
| `history` / `ticks` | from the detail DTO, converted to USD at the current rate |
| `signature` (`Trade`) | the real signature, so trade rows link to the explorer |

Keep at most 2,000 coins in memory (LRU by last seen). Never drop the selected coin or coins the wallet holds or owns.

### 5.4 Holdings and fees waiting

- Holdings come from `getToken2022Holdings(owner)` (`getTokenAccountsByOwner` with `programId` Token-2022, base64
  decode) and are intersected with registry mints. **Sell 25%/50%/100%** compute from `holdingsRaw` in bigint.
- Fees waiting is shown from `coin.real.feesWaitingLamports` (indexer ≤ 10 min old, refreshed by `?fresh=1` on select
  and after own txs). The claim modal and the owner card use `chain.getVault()` for exact live lamports.

---

## 6. Devnet test wallet (CHAIN: `src/dev`)

- **Entry `src/dev/index.ts`: `installDevTools(config: ConfigResponse): void`.**
  - It registers a Wallet Standard wallet with `registerWallet` from `@wallet-standard/wallet`: name
    **`Devnet Test Wallet`**, an inline SVG icon, `chains: ['solana:devnet']`.
  - Features:
    - `standard:connect`: no prompt; creates or loads the keypair from localStorage `cs_devnet_test_wallet_v1`
      (try/catch; falls back to an in-memory key);
    - `standard:disconnect` and `standard:events`;
    - `solana:signTransaction`: auto-approves and shows the toast "Signed by Devnet Test Wallet";
    - `solana:signMessage`;
    - `solana:signAndSendTransaction`: signs and sends through `/api/rpc`.
  - On connect, if the balance is under 0.5 SOL, it calls `POST /api/dev/airdrop` (toast "Getting test SOL…").
  - It exports `window.__csTestWallet = { address, airdrop() }` for automated E2E. It **never** exposes the secret key.
  - The file contains the marker string `cs-devnet-test-wallet-v1`, which `check-bundle` greps for.
- **Loading (APP, `App.tsx`)**, inline-guarded so Vite and Rolldown drop it from other builds:

  ```ts
  if (import.meta.env.VITE_TEST_WALLET === '1' && import.meta.env.VITE_CLUSTER === 'devnet') {
    if (IS_REAL && config.cluster === 'devnet' && config.features.testWallet) {
      void import('./dev/index').then((m) => m.installDevTools(config));
    }
  }
  ```

- **On demand (round-1).** App registers a loader with `src/wallet/solanaWallets` (`setExtraWalletLoader`); the dev chunk
  (and web3.js) loads only when a wallet list opens, the Connect pill is hovered / focused, or the saved session is the
  test wallet (silent restore waits for it). `window.__csTestWallet` therefore exists only after that (E2E drivers open the
  wallet modal first). It never depends on the faucet; the auto top-up runs only while `features.faucet` is true.
- **Proof.** `scripts/check-bundle.mjs dist-mainnet` must find none of `cs-devnet-test-wallet-v1`, `Devnet Test Wallet`,
  `/api/dev/` or `devCode`, and no chunk importing `src/dev`. The Worker mainnet dry-run bundle
  (`wrangler deploy --dry-run --env mainnet --outdir .wrangler/check-mainnet`) must not contain `/api/dev/`,
  `screenVerifier` or `DEV_FAUCET`.

---

## 7. UX for real transactions (APP; DESIGN visual language, existing components)

### 7.1 Network chip (replaces the DEMO chip in real mode, same `.topright` slot, `<button>`)

- **Devnet.** `.net-chip`: dot + `DEVNET` + `<span> · test SOL</span>` (desktop) / `<span> · test</span>` (tablet and
  mobile).
  - Colours are new tokens in `tokens.css`: `--cs-devnet-container: #ede7ff; --cs-on-devnet-container: #3b2a8c;
    --cs-devnet-dot: #7b4fd5`.
  - Clicking it opens the **Devnet explainer** (same shell as the DEMO explainer):
    - h2 `You're on Solana devnet`;
    - body: `Coins and SOL here are test tokens with no value. Use a wallet set to Devnet.`;
    - rows: `Get test SOL` (test wallet: airdrop; any other wallet: new tab `https://faucet.solana.com`), `Switch Phantom
      to Devnet: Settings → Developer settings → Testnet mode`, and `Open the demo` (`?mode=demo`);
    - button `Got it`.
- **Mainnet:** no chip.
- **Demo mode:** the DEMO chip, unchanged.

### 7.2 Notes under actions (replace `Demo — no real transaction`)

| Mode | Note |
|---|---|
| devnet | `info` `Devnet — test SOL, no real value` |
| mainnet | `info` `Real transaction on Solana` |
| demo | unchanged |

Launch Review detail rows become:

- `Network` `Solana devnet` / `Solana`;
- `Network fee + rent` `≈ 0.0103 SOL` (from `estimateLaunchCost`; never "(simulated)");
- `First buy`;
- `Platform cut 0%`.

### 7.3 Transaction states (shared `TxProgress` → UI; reuse `Button loading`, `.tf-help.err`, toasts)

| Phase | Trade button / modal row | Busy rule |
|---|---|---|
| `preparing` | spinner + `Preparing…` | cancellable (Esc closes, nothing was sent) |
| `awaiting-signature` | spinner + `Approve in {Wallet}…`, helper `Check your wallet window` | not busy: closing the modal is allowed; a later rejection resolves quietly |
| `sending` | `Sending…` | **busy** (close, Esc and scrim ignored) |
| `confirming` | `Confirming on Solana…`, after 5 s `Confirming… {n}s` | busy |
| `registering` | `Putting it on the map…` (launch) / `Recording your claim…` | busy |
| success | toast with the real fill, e.g. `Bought 2.36M $KEBAB for 0.1 SOL` + action `View tx` (explorer, new tab) | – |
| error | `.tf-help.err` with `TxError.message` + `Try again` when `retryable`; `View tx` when `signature` exists | – |

**Risk + Terms consent (first transaction).** `runTx` (src/realdata/tx.ts), the one path every launch, trade, claim,
finalize and withdraw starts from, waits for a one-time consent before the first transaction in a browser
(src/legal/consent.ts; sheet src/legal/ConsentGate.tsx, mounted by SharedModals over any open dialog): the high-risk
warning and two boxes, 18+ and not in a blocked or restricted region (no VPN), and the Terms (linked, with Privacy).
Stored in localStorage `cs_consent` as `{v, cluster, at}`: raising `CONSENT_VERSION` asks everyone again, and a devnet
acceptance never counts on mainnet. Cancel, Esc or the scrim → `rejected` with `sent: false`: nothing is signed or sent.
Asked on devnet too, never in the demo. Once on record, `runTx` starts synchronously as before.

**Launch modal step 4a** keeps DESIGN's three rows:

| Row | Behaviour |
|---|---|
| 1 `Creating the coin on pump.fun` | Spinning from `preparing` through `confirming`. Sub-label = the phase text |
| 2 `Pointing creator fees to the shop's vault` | Checks together with row 1 when the tx confirms (it is the same atomic tx) |
| 3 `Putting it on the map` | `registering` |

- **Step 4b.** The first buy line uses `LaunchValue.devBuy` (actual).
- **Errors.** `taken` → DESIGN's "Someone launched this shop first" screen with `View $X` (`TxError.existing`). Anything
  else → "Launch failed": the sub-text is `TxError.message`, and there is a `View tx` link when sent.
- **Wallet disconnected mid-flow** → DESIGN's existing step-2 rule.

**Trade box (DESIGN §8.11):**

- `You receive ≈` comes from `quoteBuy`/`quoteSell`, debounced 250 ms and refreshed every 5 s while the box is visible.
- Add a 12/16 text-2 line: `Min {minTokensOut} · Fee {fee} SOL`.
- `Slippage 2%` (200 bps).
- Disabled states:
  - `Not enough SOL` when `lamportsIn + fee reserve 0.003 SOL > balance`; on devnet add a `Get test SOL` text button;
  - `Price impact too high` when impact is above 15%.
- `Balance x SOL` is real (§5.2).

### 7.4 Launch modal (real mode)

- **Details → Continue.** Call `checkEligibility(placeId)` (spinner on Continue).
  - `not_business` → inline screen: h2 `This place can't have a coin`, sub `Only open businesses can be launched.`,
    buttons `Close` and `Find a shop`.
  - `closed` → sub `This business is marked as closed on Google.`
  - `taken` → the taken screen.
- **Hide Launch early** when the selected place's known `types`/`primaryType` (search, link or POI data already in
  memory) fail `launchIneligibility`. This covers plus codes, cities, roads and regions (Phase-1 minor #4). POI clicks
  with no types still go through the server check.
- **Art.** Uploads are re-encoded to 512×512 WebP ≤ 200 KB. Stickers are rendered (emoji 300 px centred on `bg`) to a
  512×512 PNG. Both are uploaded as `image`.
- **Prefetch.** `prefetchChain()` when the modal opens; `prefetchPump()` on Details → Continue.
- **Sign in** (step 2) shows the wallet list only; email is hidden in real mode (§1.9).

### 7.5 Claim modal (real mode; DESIGN §12.3 structure kept)

- **Verify.** `GET /api/claim/status` first:
  - `pending` → banner `A claim for this shop is in its public window until {date}.`, primary disabled;
  - `verificationActive` → DESIGN's "Someone is verifying".
  - `Call me with a code` → `/api/claim/call`.
- **Code.**
  - Devnet (`channel:'screen'`): the call-status row reads `Devnet: no call is made` and the amber box shows
    **`Devnet: your code is 123 456`** (the real `devCode`).
  - Mainnet: the real call; the cooldown comes from `resendAfterSec`.
  - Wrong codes use `attemptsLeft`.
- **Payout.**
  - **The payout wallet must be the connected wallet**, because it signs `request_claim`. Hide the `Another address`
    card in real mode and show the sub `To get paid to another wallet, connect that wallet first.`
  - Primary `Request claim` → `chain.requestClaim` (tx states, §7.3).
  - The amber box reads `{window}-hour public window before you can withdraw`, built from `claimWindowSecs` with
    `formatWindow()` → `72-hour` / `1-minute` (devnet).
- **Done.** h2 `Claim requested`, sub `After the {window} public window you can withdraw {fees} to {addr}. Anyone can
  dispute a wrong claim until then.` If `inProbation`: `Because our signing key changed recently, this claim unlocks
  on {date}.`
- **Fees card states (§8.9 additions):**
  - pending → h2 `Claim pending`, p `Unlocks in {countdown}` (`2 d 23 h`, `23 h 59 m`, `59 m 12 s`; a probation
    claim reads up to `9 d 23 h`); when unlocked, primary `Finalize` (anyone, `finalizeClaim`);
  - owner → primary `Withdraw {usd}` (`collectAndWithdraw`), shown when `fees.waiting > 0`, plus `Payout settings`
    showing the owner wallet (re-claim to change it).
- **Other ways.**
  - Website card: enabled only when `features.websiteVerification && isOwnBusinessHost(websiteHost)`; otherwise disabled
    with `This listing has no website of its own`.
  - Email card: disabled, `Not available yet`.
  - Manual card (only while `features.manualReview`): submits `/api/report` (`kind:'manual_claim'`) and shows DESIGN's
    review-Done variant.
- **Probation banner** (SPEC §8.6) on shop pages while `config.probationUntil > now`.

### 7.6 Links (DESIGN §18.2 "Simulated link" rows become real in real mode)

- Solscan token, account and tx links use `explorer.ts` (cluster-aware).
- `Chart on DexScreener` and `Trade on pump.fun` are **hidden on devnet**, because neither supports devnet. They are
  shown on mainnet.
- Trade rows link to the explorer tx.
- Account menu `View on Solscan` → `explorerAddress`.
- `Report` and `Business opt-out` → `POST /api/report` (toast `Thanks — we'll review it`).

### 7.7 Insufficient SOL

The launch Review and the trade box check `balance ≥ cost + 0.003 SOL` before any wallet prompt. On a shortfall:

- show `Not enough SOL — you need about {x} SOL (you have {y})`;
- devnet: add a `Get test SOL` button (test wallet: airdrop; other wallets: faucet tab);
- mainnet: `Add SOL to your wallet to continue`.

### 7.8 Remaining Phase-1 minors (APP, P0)

1. **Mobile hit areas.** Every control is ≥ 44×44 at < 768 px (`.hit`), notably: the demo-shop `Open in Maps`, footer
   links, Help links, and the wallet `Terms`/`Privacy` links. Add a test that measures every interactive element at
   375 px.
2. **Focus.** After the launch modal closes on Success, focus goes to the new coin's panel heading, or to the invoking
   control if that still exists. Never to `<body>`.
3. **Website/email verification hosts.** Use `isOwnBusinessHost()`; platform hosts (TripAdvisor, Facebook, …) disable
   both cards.
4. **Non-business places are not launchable** (`launchIneligibility`, plus the server check; §7.4).
5. **Help `Report a coin` with no coin selected.** The Report sheet shows a `Coin link or mint` field (required) instead
   of failing silently.
6. **Live panel extras not in DESIGN.** Keep them if harmless, and list each one in CONTRACTS.md §9 (integration
   decisions) with one line of rationale.

---

## 8. Performance budgets (checked by `scripts/check-bundle.mjs` + smoke; failures block sign-off)

| Metric | Budget |
|---|---|
| Initial JS (entry + static imports), real-mode devnet build, gzip | **≤ 170 KB** (today 162 KB with demo data; moving `src/data/**` behind a dynamic import pays for `src/realdata` + light chain) |
| Initial CSS gzip | ≤ 32 KB |
| Chain core chunk (web3.js + shop-vault client + `src/chain` heavy) | ≤ 160 KB gz, loaded on intent (`prefetchChain` on idle once a wallet connects or a launch/trade UI opens) |
| pump SDK chunk | separate chunk, ≤ 450 KB gz, never on the initial path |
| AMM chunk (pump-swap-sdk) | separate, graduated coins only |
| Main-thread long task while chain chunks load | ≤ 200 ms (load during idle) |
| LCP (map shell + chrome, 4G mid-tier mobile) | ≤ 2.5 s; INP ≤ 200 ms |
| API p95 at the edge (warm) | `/api/config` ≤ 80 ms · `/api/coins` ≤ 150 ms · `/api/coins/:mint` ≤ 150 ms (fresh ≤ 600 ms) · `/api/market` ≤ 250 ms (cache hit ≤ 60 ms) · `/api/feed` ≤ 120 ms · `/api/rpc` overhead ≤ 40 ms over upstream · `/api/metadata` ≤ 600 ms · `prepare` ≤ 900 ms · `cosign` ≤ 400 ms · `confirm` ≤ 1.5 s |
| Launch, click → success, excluding wallet approval (devnet) | p50 ≤ 6 s, p95 ≤ 12 s |
| Trade, click → confirmed toast, excluding approval | p50 ≤ 3 s, p95 ≤ 8 s |
| Requests per visible viewer per minute | idle, no wallet: ≤ 12 `/api/market` + ≤ 12 `/api/feed` + viewport `/api/coins` · **0 `/api/rpc`** · wallet connected: + ≤ 4 `/api/rpc` · one trade ≤ 12 `/api/rpc` calls in total |
| Upstream Alchemy per Worker isolate | `/api/market` ≤ 30 getMultipleAccounts/min (2 s cache) · cron ≤ 40 calls per run |
| Static caching | `public/_headers`: `/assets/*  Cache-Control: public, max-age=31536000, immutable`; `index.html` revalidates |

Credits: devnet fits the Alchemy Free plan (30M compute units per month) at test traffic. Mainnet with real traffic needs Alchemy
Developer (10M). The checklist covers this.

---

## 9. Accuracy rules (what is shown vs the source of truth)

| Shown | Source of truth | Max staleness | Tolerance and rounding |
|---|---|---|---|
| Price (curve) | BondingCurve virtual reserves | visible coins 7 s · selected 7 s · lists 60 s | **Exact** at read time (bigint math, §4.3). Display: `usdPrice` with 3 significant digits; SOL with 3 significant digits |
| Price (graduated) | pool vault balances (+ virtual quote) | 7 s | Within ±0.1% of the pump-swap-sdk spot quote (checked on devnet) |
| Market cap | `vQuote × supply / vToken` (pump formula) | as price | exact; `usdCompact` |
| USD values | SOL × SOL/USD (Jupiter; Pyth fallback) | 60 s | ±0.5% vs Pyth. Older than 10 min → show SOL only and hide USD (`—`) |
| Fees waiting (cards, pins, This area) | SPEC §8.5 `feesWaiting()` over vault, state, pump creator vault, curve bucket, WSOL | lists 10 min · selected coin 15 s · after an own tx: immediate | **Exact lamports. Always round DOWN** (never overstate money owed). SOL with 4 dp, USD with `usdFull` |
| Fees earned (Top by fees) | `total_withdrawn + waiting` | 10 min | exact lamports, round down |
| Volume 24h, change 24h | D1 trades (curve + AMM events) | indexer lag ≤ 2 min | Complete once caught up (the audit compares the trade count with `getSignaturesForAddress`). Change in SOL terms, 1 dp |
| Holders | Token-2022 accounts with amount > 0, excluding pool and curve | 60 min | shown with the tooltip `Updated hourly`; `—` when unknown |
| Recent trades | D1 (or the own tx immediately via `/api/index/tx`) | 2 s own · ≤ 60 s others | exact amounts: SOL 4 dp (`<0.0001 SOL` floor), tokens `tokenAmount` |
| Buy "You receive ≈" | SDK quote on state ≤ 2 s old | refreshed 5 s | exact for that state; min-out = quote × (1 − slippage), **round down** |
| Sell "You receive ≈" | SDK quote | 5 s | as above, round down |
| Wallet SOL balance | `getBalance` (confirmed) | 30 s, plus immediately after txs | lamports exact; display 4 dp, round down |
| Holdings | Token-2022 accounts | as balance | base units exact; 100% sell uses raw units |
| Owner / pending / unlock | VaultState | lists 10 min · claim modal live | exact; countdown from `unlockTs` (chain clock) |
| Claim window copy | Config `claim_window_secs` | 60 s | exact (`72-hour` / `1-minute`) |
| Launch cost estimate | rent via `getMinimumBalanceForRentExemption` + 3 signatures + priority × CU + dev buy | live | ±0.0005 SOL; never below the true cost |

**Input parsing.** Amount inputs parse strings to bigint (SOL ≤ 9 dp, tokens ≤ 6 dp). There is no float math on money
before display. Formatting goes through `src/lib/format.ts` (existing helpers) for display only.

**Audit.** `scripts/accuracy-audit.mjs` re-derives every number above for N coins directly from chain (local Alchemy) and
compares it with `/api/coins/:mint` and `/api/market`. It exits non-zero outside tolerance and is part of devnet
sign-off.

---

## 10. Scripts, runbook and checklist (OPS)

### 10.1 Rules for every script

- Node ≥ 22.18 (built-in type stripping, as `programs/shop-vault/scripts/devnet-e2e.ts` does) or bash with
  `set -euo pipefail`.
- Load the Solana CLI with `export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"`.
- **Default `DRY_RUN`.** Sending needs `--execute`. Check the genesis hash before any send. Mainnet sends exist only in
  `go-mainnet` (H1).
- Print only the RPC origin (`new URL(rpc).origin`), never its query string. **Never print a key, secret, seed phrase,
  token or phone number.** Filter CLI output the way `devnet-deploy.sh` does.
- Helpers (`scripts/lib/`):
  - `env.mjs`: parses `.env.server` into memory;
  - `keys.mjs`: `pubkey(path)`, `secretB64(path)` for piping only, `ensureKey(path)`;
  - `rpc.mjs`: Alchemy URL from `ALCHEMY_API_KEY` + cluster, `label()` = origin;
  - `deployJson.mjs`: read and write `deploy/<cluster>.json`;
  - `secretPut.mjs NAME --env X`: pipes the value into `npx wrangler secret put NAME --env X` through stdin.

### 10.2 Scripts

| Script | What it does |
|---|---|
| `scripts/fund-devnet.mjs` | `requestAirdrop` (1 SOL × n, via Alchemy devnet) for the deployer. On failure, prints `https://faucet.solana.com` plus the **pubkey** to fund. Target deployer balance ≥ 8 SOL (program ≈0.52 peak, ALT, crank 0.2, faucet 3, e2e and graduation ≈4) |
| `scripts/init-config.mjs --cluster devnet [--window 60] [--execute]` | If Config is missing: `initializeConfig(attestor, governance, guardian, window)` signed by the upgrade authority. Checks the `ConfigInitialized` marker and `flavor` |
| `scripts/create-alt.mjs --cluster devnet\|mainnet [--execute]` | Creates, extends (the exact 14 `ALT_KEYS`) and freezes the ALT. Verifies the content and the frozen state, then writes `deploy/<cluster>.json.alt`. Idempotent (verifies an existing ALT). Mainnet: only callable from `go-mainnet` |
| `scripts/dev-vars.mjs devnet` | Writes `.dev.vars.devnet` (mode 600) |
| `scripts/deploy-devnet.sh` | 0) preflight (wrangler logged in to the AtlasPad Cloudflare account, checked by account id in `scripts/lib/wrangler.mjs` (`CS_CLOUDFLARE_ACCOUNT_ID` for a fork), Node, solana CLI, `.env.server` names present, keys present or created, genesis) · 1) fund check · 2) program deployed? else `programs/shop-vault/scripts/build.sh` + `devnet-deploy.sh` · 3) `init-config` · 4) `create-alt` · 5) write `deploy/devnet.json` · 6) D1 `cornershop-devnet` (create if missing, replace `__D1_DEVNET_ID__`) + `wrangler d1 migrations apply cornershop-devnet --env devnet --remote` · 7) secrets (§1.6; `HMAC_KEY` generated once into `.keys/devnet-hmac.key`) · 8) fund crank (0.2) and faucet (3) from the deployer · 9) `npm run build:devnet` + `check-bundle dist-devnet --cluster devnet` · 10) `npx wrangler deploy --env devnet --var ALT_ADDRESS:<alt> --var BUILD_ID:<ts>-<hash>` (refuses unless `env.devnet.name === 'cornershop-devnet'`) · 11) `smoke.mjs` |
| `scripts/check-bundle.mjs <dist> --cluster devnet\|mainnet [--worker <dir>]` | Size budgets (§8) · pump SDK in its own chunk · **no secret value** from `.env.server` or `.keys/*` (compared in memory) in any file · no `g.alchemy.com` URL or the Alchemy key in client files · mainnet: the H6 markers are absent (§6) |
| `scripts/smoke.mjs <origin> [--cluster]` | `/api/health ok` · `/api/config` cluster and attestor match `deploy/<cluster>.json` · `/api/rpc` `getLatestBlockhash` OK · `getProgramAccounts` → -32601 · cross-origin POST → 403 · `/api/dev/airdrop` present on devnet, `404` on mainnet · **no response body contains the Alchemy key** (in-memory compare) |
| `scripts/e2e-devnet.ts` | Headless API-level E2E against the deployed Worker using `.keys/devnet-{launcher,buyer,owner}.json`, the shop-vault client and pump-sdk (`createRequire`, like `devnet-e2e.ts`). Steps: launch `cornershop-test:e2e-<ts>` through metadata, prepare, cosign, send, confirm · second launch → `409 taken` · buy/sell v3 → `/api/index/tx` → the feed has them within 5 s · fees waiting == Σ `TradeEvent.creatorFee` (exact) · claim: call (devCode) → check → cosign → send → confirm → wait 61 s → cron finalize (or `finalizeClaim`) → withdraw pays exactly `vault − rent_min(0)` · `GRADUATE=1`: buy out the curve → `graduated` within 30 min → AMM buy and sell. JSON report to `scripts/out/` (gitignored) |
| `scripts/accuracy-audit.mjs <origin>` | §9 |
| `scripts/moderate.mjs --env devnet --hide\|--unhide <mint>` | `wrangler d1 execute … --remote --command` (parameterised; mint validated as base58) |
| `scripts/claims-admin.mjs --env devnet list\|cancel <placeId>` | Lists pending claims. `cancel`: devnet signs `cancelClaim` with `.keys/devnet-guardian.json`; mainnet prints an **unsigned** base58 tx for the hardware guardian / Squads |
| `scripts/go-mainnet.mjs` | §10.3. **Never runs automatically**; this workflow only runs `--dry-run` (read-only mainnet RPC) |

`package.json` scripts (OPS):

```json
"dev:devnet": "VITE_CLUSTER=devnet VITE_TEST_WALLET=1 vite",
"worker:devnet": "wrangler dev --env devnet --port 8787",
"build:devnet": "npm run typecheck && VITE_CLUSTER=devnet VITE_TEST_WALLET=1 vite build --outDir dist-devnet --emptyOutDir",
"build:mainnet": "npm run typecheck && VITE_CLUSTER=mainnet VITE_TEST_WALLET= vite build --outDir dist-mainnet --emptyOutDir",
"check:bundle": "node scripts/check-bundle.mjs",
"deploy": "echo 'Refusing: use deploy:devnet (this workflow). The demo Worker is deployed only by the integrator.' && exit 1",
"deploy:devnet": "bash scripts/deploy-devnet.sh",
"smoke:devnet": "node scripts/smoke.mjs https://cornershop-devnet.tiejiucai.workers.dev --cluster devnet",
"e2e:devnet": "node scripts/e2e-devnet.ts",
"audit:accuracy": "node scripts/accuracy-audit.mjs",
"go-mainnet": "node scripts/go-mainnet.mjs --dry-run"
```

`build` (no `VITE_CLUSTER`) stays the demo-only build for the current `cornershop` Worker.

### 10.3 `scripts/go-mainnet.mjs` (scripted, checked, human-started)

Default `--dry-run` runs every preflight read-only and prints the plan. `--execute` additionally requires an interactive
TTY and the typed phrase **`DEPLOY ATLASPAD TO MAINNET`**. It refuses non-TTY input, and refuses when any preflight
fails.

**Preflight** (each prints ✓ or ✗; no secrets printed):

1. Artifact: `programs/shop-vault/scripts/build.sh`, then `check-artifact.sh target/deploy/shop_vault.so mainnet --verified`.
   This checks size < 40,960 B, the `shop-vault-build:mainnet` marker, no devnet marker, and a solana-verify hash
   recorded. Never anything from `target/deploy-devnet/`.
2. Mainnet RPC (Alchemy mainnet) genesis == mainnet. The program id is not deployed yet, or `--upgrade` is set.
3. Deployer: `--deployer <keypair path>` (the user's wallet), with balance ≥ 0.6 SOL. Show the rent estimate:
   `2 × size × 5,080 lamports + ALT + fees`, about 0.52 SOL peak and about 0.26 SOL locked.
4. Keys:
   - `.keys/mainnet-attestor.json` and `.keys/mainnet-crank.json` exist (create them on request);
   - `deploy/mainnet.json.guardian` is set (a wallet on its own device; hardware wallet recommended);
   - Squads vault A (governance, `--squads-a`) and vault B (upgrade authority, `--squads-b`) are given;
   - all are distinct (SPEC I10);
   - Squads A time lock < claim window − 24 h (SPEC §11): the user confirms this by typing it.
5. Worker: D1 `cornershop-mainnet` exists and is migrated (`__D1_MAINNET_ID__` replaced).
   `wrangler secret list --env mainnet` shows `ALCHEMY_API_KEY, GOOGLE_SERVER_KEY, ATTESTOR_SECRET, CRANK_SECRET, HMAC_KEY,
   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID, TURNSTILE_SECRET_KEY`, and **does not** show
   `DEV_FAUCET_SECRET`. The Twilio service has `code_length == 6`, and voice geo permissions are confirmed by typing.
6. `npm run build:mainnet` + `check-bundle dist-mainnet --cluster mainnet --worker .wrangler/check-mainnet` (H6 proofs).
7. Google browser key referrers include the mainnet origin. Workers Paid plan confirmed (typed `yes`).
   `MAINNET-CHECKLIST.md` has every box ticked (the script parses `- [x]`).

**Execute** (SPEC §11 order; each step simulates first and is idempotent on resume):

1. `solana program deploy target/deploy/shop_vault.so --program-id .keys/shop-vault-program.json --max-len <size>
   --upgrade-authority <deployer> --use-rpc`. Output is filtered for seed phrases.
2. `initialize_config(attestor_mainnet, governance = deployer, guardian, 259200)`. Verify `flavor == 0`,
   `rotation_delay_secs == 604800` and the marker.
3. `create-alt --cluster mainnet --execute` → `deploy/mainnet.json`.
4. Fund the crank with 0.1 SOL from the deployer.
5. `wrangler deploy --env mainnet --var ALT_ADDRESS:… --var BUILD_ID:…`. **This replaces the demo at
   cornershop.tiejiucai.workers.dev**, which from then on 301s to https://atlaspad.online (the Custom Domains are
   created by this deploy). Rollback: `wrangler rollback --env mainnet` restores the previous version.
6. `smoke.mjs https://atlaspad.online --cluster mainnet` (read-only; also checks the www and workers.dev redirects).
7. Print the manual follow-ups (not automated):
   - `propose_governance(Squads A)` (printed as an unsigned tx for the deployer to sign), then accept through Squads;
   - `solana program set-upgrade-authority … --new-upgrade-authority <Squads B>`;
   - start the guardian watchdog (not the request-path Worker);
   - one smoke launch on a business the user owns, with dev buy 0;
   - after ≥ 30 days, review then `--final`.

**Squads note.** Governance (vault A) and upgrade authority (vault B) are different multisigs, and A's time lock must
stay below `claim_window_secs − 24 h` (SPEC T11b). The script never holds Squads member keys.

### 10.4 `RUNBOOK.md` (OPS) must cover

- Local dev (§1.10).
- Deploy and redeploy devnet; rollback with `wrangler rollback --env devnet`; D1 time travel
  (`wrangler d1 time-travel restore`).
- Funding devnet: faucet URL, deployer and faucet pubkeys, `fund-devnet`.
- Phantom/Solflare/Backpack devnet settings.
- Manual E2E with a real wallet, and the automated `e2e:devnet`.
- Secret rotation: Alchemy, Google, HMAC (resets rate limits only), and the attestor rotation runbook from SPEC §5.8
  (pause → cancel rogue claims → propose + accept → `wrangler secret put ATTESTOR_SECRET` → unpause → probation banner).
- Alerts triage (§3.7 kinds) and pre-registering planned admin proposals in `admin_expectations`.
- Moderation (hide a coin, opt-out requests).
- Claims admin.
- Cron limit fallback.
- Alchemy credit monitoring.
- Incident: "pump `admin_cto` on one of our coins" (SPEC T13).

### 10.5 `MAINNET-CHECKLIST.md` (OPS): checkboxes `- [ ]`, parsed by `go-mainnet`

- **Devnet sign-off:**
  - `e2e:devnet` green, including `GRADUATE=1`;
  - accuracy audit green;
  - manual E2E with Phantom and Solflare;
  - `check-bundle` mainnet green;
  - 48 h cron soak with no critical alerts.
- **Funds:** 0.6 SOL sent to the deployer wallet (≥ 0.59 after the Squads rent; ≈0.29 locked incl. 0.1 SOL for the crank, buffer refunded).
- **Accounts:**
  - Workers Paid;
  - Alchemy mainnet key (separate AtlasPad key and plan recommended);
  - Twilio (Verify service `code_length` 6, voice geo permissions GB+, friendly name `AtlasPad`);
  - Turnstile site and secret;
  - Google browser key referrer for the mainnet origin, `https://atlaspad.online/*`;
  - optional Jupiter key and Privy app id.
- **Keys and governance:**
  - `mainnet-attestor` generated offline, copied to the Worker secret, then kept offline;
  - guardian: a wallet on its own device (hardware wallet recommended);
  - Squads vault A 2-of-3 hardware, time lock ≤ 48 h;
  - Squads vault B for the upgrade authority;
  - all distinct;
  - `admin_expectations` process agreed.
- **Domain decided** before launch: metadata URIs are permanent; workers.dev stays enabled forever.
- **Legal and disclosure:**
  - legal review: the operator's responsibility;
  - pump.fun `admin_cto` and upgrade risk disclosure in Help;
  - "not affiliated" copy;
  - takedown route working.
- **Monitoring:** `ALERT_EMAIL_TO` or `ALERT_WEBHOOK_URL` set; guardian watchdog running; on-call owner named.

### 10.6 `.env.example` (OPS): names only, never values

Variables: `VITE_GOOGLE_MAPS_KEY`, `VITE_CLUSTER`, `VITE_TEST_WALLET`, `CS_API_PROXY`.

Server-only names, documented as "set with `wrangler secret put`, never `VITE_`": `GOOGLE_SERVER_KEY`, `ALCHEMY_API_KEY`,
`HMAC_KEY`, `ATTESTOR_SECRET`, `CRANK_SECRET`, `DEV_FAUCET_SECRET` (devnet only), `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID`, `TURNSTILE_SECRET_KEY`, `JUPITER_API_KEY`, `ALERT_WEBHOOK_URL`, `ALERT_EMAIL_TO`.

---

## 11. Integration plan, shared changes and acceptance

### 11.1 Shared changes (INTEGRATOR applies these first, so builders can install and typecheck)

1. `package.json` dependencies, **exact pins**:
   - `@solana/web3.js` `1.99.0`
   - `@pump-fun/pump-sdk` `3.2.0`
   - `@pump-fun/pump-swap-sdk` `2.1.0`
   - `@solana/spl-token` `0.4.14`
   - `bn.js` `5.2.2`
   - `buffer` `6.0.3`
   - `@noble/hashes` `1.8.0`
   - `@wallet-standard/wallet` `1.1.1`
   - `@solana/wallet-standard-features` `1.5.0`
   - `@cornershop/shop-vault-client` `file:programs/shop-vault/client`

   Plus `.npmrc` with `install-links=true`. It installs the client as a packed copy, so `@solana/web3.js` resolves to
   **one** copy for both Vite and wrangler.
2. `vite.config.ts`:
   - `resolve.dedupe: ['@solana/web3.js', 'bn.js', 'buffer', '@solana/spl-token']`;
   - `define: { global: 'globalThis' }`;
   - `optimizeDeps.include: ['buffer', '@solana/web3.js']`.

   Add a unit test that `sv.SHOP_VAULT_PROGRAM_ID instanceof PublicKey` holds (a single web3.js copy).
3. `src/env.d.ts`: `VITE_CLUSTER?: 'devnet' | 'mainnet' | ''`, `VITE_TEST_WALLET?: '1' | ''`.
4. `.gitignore`: `dist-devnet/`, `dist-mainnet/`, `scripts/out/`, `.dev.vars*` (already there), `.keys/` (already there).
5. `public/_headers`: immutable `/assets/*` (§8).
6. CONTRACTS.md: add a pointer to this file, and note that the "never sign" rule applies to demo mode only.

### 11.2 Order of work (parallel; dependencies in brackets)

| Builder | Steps |
|---|---|
| **OPS** | `fund-devnet` → program deploy + `init-config` + `create-alt` on devnet → `deploy/devnet.json` → D1 + secrets → first `deploy:devnet` as soon as BACKEND has `/api/health` + `/api/config` → `smoke`, `check-bundle`, `e2e-devnet`, `go-mainnet --dry-run`, RUNBOOK, checklist |
| **BACKEND** | wrangler envs + migration → `/api/config`, `/api/health`, `/api/rpc` → read endpoints (empty registry is fine) → metadata + assets → launch prepare/cosign/confirm → indexer (curve) → claims (screen verifier, Twilio adapter + fake) → dev airdrop → P1 items |
| **CHAIN** | light modules first (`curve`, `amounts`, `explorer`, `rpc`, `load`; APP depends on them) → `getSigner` → send/confirm + error mapping → `launchCoin` → buy/sell → vault/claim/withdraw → test wallet → AMM (P1) |
| **APP** | `mode.ts` wiring + `startRealData` behind `IS_REAL` → mapping and store → network chip and notes → trade box → launch modal → claim modal + fees card states → links → Phase-1 minors → budgets |

Day-1 spike for CHAIN: build the launch tx in the **browser bundle** (`vite build && vite preview`, a devnet build) to
flush out Buffer/anchor polyfill issues early.

### 11.3 Acceptance (devnet sign-off = all green; each row has an automated or recorded manual test)

1. `npm run typecheck`, `npm test` (existing 183 tests plus new ones) and `npm run build:devnet && npm run build:mainnet`
   all pass. `check-bundle` passes for both builds, including the Worker mainnet dry-run bundle.
2. `smoke:devnet` passes: health ok, RPC allowlist enforced, cross-origin refused, no key in any response.
3. `e2e:devnet` passes end to end (launch → duplicate refused → trades → exact fees → claim → finalize → exact
   withdraw), plus `GRADUATE=1` once.
4. Manual, real wallets (Phantom and Solflare on devnet) on https://cornershop-devnet.tiejiucai.workers.dev:
   - launch a real Google cafe with a 0.1 SOL first buy; it shows on the map with price and mcap within 7 s;
   - buy 0.1 and sell 50% from a second wallet; balance, holdings, feed and fees update;
   - claim with the on-screen code; finalize after 60 s; withdraw;
   - every Solscan link opens the right devnet page.
5. The test wallet drives the same flows in the Browser pane with no extension (automated UI pass).
6. `?mode=demo` on devnet behaves like Phase 1, with **zero** `/api/rpc`, `/api/coins` or `/api/market` requests
   (checked in the network log).
7. Accuracy audit green (§9). Budgets green (§8). The 375 px hit-area test is green.
8. `go-mainnet --dry-run` runs all its read-only preflights and lists exactly what the user still has to provide.

### 11.4 Known limits and risks (documented, not bugs)

- **Place griefing.** An attacker could hold a place's launch lock for 120 s at a time. Mitigated by per-IP and
  per-reservation limits; on-chain the first launch still wins.
- **Wallets set to mainnet** may warn when shown a devnet transaction. The devnet chip and RUNBOOK tell testers to switch.
- **Workers Free CPU/subrequest limits** may throttle the cron on devnet; Paid is required for mainnet.
- **Holders** come from `getTokenLargestAccounts` (exact below 20 token accounts); above that the D1 trade-derived count (exact while nobody transfers tokens) is a floor.
- **No vanity `…pump` mints** (random mints) until the P2 mint pool exists. Nothing may validate a `pump` suffix.
- **pump.fun admin powers** (`admin_cto`, upgrades) remain out of our control (SPEC T13). Alerts and crank mitigate them.
