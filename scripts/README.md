# scripts/ (OPS) — AtlasPad

Every script is a **dry run unless you pass `--execute`**, checks the cluster's genesis hash before sending anything,
prints public keys and names only (never a secret), and uses the public Solana RPC from this machine (or `RPC_URL`).
The Alchemy key is only ever piped into the Worker secret. Node ≥ 22.18. How-tos: `../RUNBOOK.md`.

| Script | What it does |
|---|---|
| `deploy-devnet.sh` | Devnet end to end: preflight → fund → program → config → ALT → record → D1 → crank/faucet → build → secrets → deploy `cornershop-devnet` → smoke. `--execute`, `--only a,b`, `--from x`, `--skip a`, `--upgrade-program`, `--resync-secrets`. |
| `fund-devnet.mjs` | Deployer airdrops (`--execute`), crank/faucet top-ups (`--roles --execute`), faucet.solana.com fallback. |
| `init-config.mjs` | `initialize_config` on devnet (idempotent; verifies an existing Config). Mainnet only via go-mainnet. |
| `create-alt.mjs` | Create/extend/freeze the 14-key ALT, or verify/adopt one (`--adopt <addr>`); writes `deploy/<cluster>.json`. |
| `create-squads.mjs --cluster … --payer <keypair> --members <a,b,c>` | Creates the two Squads v4 multisigs go-mainnet needs (A governance 2-of-3, time lock 0 s; B upgrade authority 2-of-3, 7-day time lock; both autonomous) without the Squads web app. Dry run checks the members, payer balance and simulates; `--execute` creates, reads both back, runs go-mainnet's Squads checks, writes `deploy/<cluster>-squads.json` and prints the `--squads-a` / `--squads-b` flags. Mainnet `--execute` asks for a typed phrase. `../docs/OPS-AUTOMATION.md` §10. |
| `dev-vars.mjs devnet` | Writes `.dev.vars.devnet` (mode 600) for `wrangler dev --env devnet`. |
| `check-bundle.mjs <dist> --cluster …` | Size budgets, lazy chunks, leak scan, mainnet has no devnet-only code and ships Terms / Privacy with no prototype wording (`--build-worker` adds the Worker bundle). |
| `smoke.mjs [<origin>] --cluster …` | Read-only checks of a deployed Worker, incl. RPC allowlist, origin check, canonical host (www, workers.dev and plain http → 301 to https://atlaspad.online) and a leak scan of every response. Without an origin: the cluster's PUBLIC_ORIGIN. |
| `e2e-devnet.ts` | API-level end to end on devnet: launch, duplicate refused, trades, exact fees, claim, finalize, exact withdraw (`GRADUATE=1` adds PumpSwap). |
| `accuracy-audit.mjs <origin>` | Every number the app shows vs the chain (exact lamports, price, mcap, fees, owner, 24 h volume, SOL/USD). |
| `watchdog.mjs --cluster …` | Governance monitor (SPEC §8.6): pending proposals vs `admin_expectations`, authorities vs the expected state in `deploy/<cluster>.json` (the Squads A/B handover is planned), alerts, `/api/health` of the cluster's PUBLIC_ORIGIN. Exit 2 = critical; `--loop <s>` / `--alert` post criticals to `ALERT_WEBHOOK_URL` (optional). Runs every 30 min on GitHub Actions (`../docs/OPS-AUTOMATION.md`), where a critical fails the run and GitHub emails you. |
| `deploy-mainnet-hotfix.mjs` | Post-launch Worker fix: dry run by default; `--execute` rebuilds, check-bundle, deploys `cornershop` with every var preserved (`ALT_ADDRESS`/`PROGRAM_ID` from `deploy/mainnet.json`), then smoke. `--migrate` for new D1 migrations. |
| `admin-expect.mjs` | Pre-register a planned admin proposal so the monitor does not treat it as an attack. |
| `moderate.mjs` | Hide/unhide a coin, business opt-out, list reports (UI-only; on-chain coins are untouched). |
| `update-sanctions.mjs` | Rebuild `worker/data/sanctioned-wallets.json` (wallet screening) from OFAC's SDN list (`--check`: exit 1 when out of date; `--file <xml>`: offline). |
| `claims-admin.mjs` | List active claims; guardian cancel (devnet signs; mainnet prints an unsigned tx). |
| `guardian.mjs --cluster … [cancel <placeId> \| pause \| unpause] [--lan]` | Local page for a guardian on Phantom: builds and simulates `cancel_claim` / `set_paused`, refuses unless the connected account is `Config.guardian` on chain, then Phantom signs and sends. Holds no key. `--lan` serves it on the Wi-Fi address for Phantom's in-app browser. `../RUNBOOK.md` §8 "Guardian". |
| `go-mainnet.mjs` | The only path to mainnet. Default `--dry-run` (read-only, lists what is missing); `--execute` needs a TTY, all ✓, typed confirmations and `DEPLOY ATLASPAD TO MAINNET`. Serves https://atlaspad.online (`env.mainnet` PUBLIC_ORIGIN). |
| `og-card.mjs` | Renders the AtlasPad share card `public/og.png` (1200×630) from `design/og-card.html` with the local headless Chrome. |
| `lib/` | Shared helpers: env parsing, key files, redaction, RPC, deploy json, wrangler, secrets piping, Squads decode, events, public origin (`origin.mjs`). |
| `test/` | `node --test scripts/test/*.test.mjs` (pure logic, no network). |

Outputs (reports, run records) go to `scripts/out/` (gitignored). Public addresses live in `../deploy/<cluster>.json`.
