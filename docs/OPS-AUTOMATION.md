# AtlasPad ops automation (free tier)

How AtlasPad watches mainnet, backs it up, ships a fix and builds a verifiable program, at no cost. Everything here
runs on GitHub Actions in the repo `AtlasPadHQ/atlaspad` or on your own machine. Nothing here holds a key that can move
money. Background: `../RUNBOOK.md` (how to operate), `../MAINNET-CHECKLIST.md` (what must be true first).

The repo is public, and so is everything its workflows leave behind: anyone can read the run logs, and any signed-in
GitHub user can download the artifacts. The workflows are written for that: the watchdog logs alert counts only
(section 2) and the database backup is uploaded only encrypted (section 3).

Internal names stay `cornershop` (the Worker `cornershop`, the database `cornershop-mainnet`).

## 1. What you can add (none of it is required)

The Worker's own alerts (every claim, dispute, report, opt-out and critical monitor alert) need no GitHub secret: they
are emailed for free to `ALERT_EMAIL_TO` in `.env.server` (an address verified in Cloudflare Email Routing; the Worker
sends from `alerts@atlaspad.online`) and/or posted to `ALERT_WEBHOOK_URL` (RUNBOOK section 8). go-mainnet pushes both.

The watchdog below needs no secret either: a critical finding **fails its run, and GitHub emails you about the failed
run**. That is the watchdog's free email channel (it runs off the Worker, so it cannot use the Worker's email). GitHub
sends it to whoever last changed the watchdog's `cron` line (whoever created the workflow, until someone edits that
line), as long as their GitHub notification settings email failed Actions runs (Settings → Notifications → Actions).

GitHub → the repo → **Settings → Secrets and variables → Actions → New repository secret**. Names are exact.

| Secret | Needed for | Required? | Where to get it |
|---|---|---|---|
| `ALERT_WEBHOOK_URL` | watchdog criticals on Discord as well | optional | Discord: your server → a private channel → Edit channel → Integrations → Webhooks → New Webhook → Copy Webhook URL. Free. Put the same URL in `.env.server` as `ALERT_WEBHOOK_URL` if the Worker's own alerts should go there too. |
| `CLOUDFLARE_API_TOKEN` | lets the watchdog read D1; the daily off-Cloudflare D1 backup | optional | dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token → Permissions: **Account · D1 · Edit** → Account resources: your account → Create. (Edit is needed because the D1 export and query endpoints are write-scoped; the workflows only read.) On its own it does not start the backup, which also needs `D1_BACKUP_PASSPHRASE` and the `D1_BACKUP_ENABLED` variable below. Without any of them the backup is skipped: D1 Time Travel already gives point-in-time restore on the free plan (section 3). |
| `CLOUDFLARE_ACCOUNT_ID` | same | optional (with the token) | dash.cloudflare.com → Workers & Pages → the Account ID in the right-hand column. |
| `ALCHEMY_API_KEY` | watchdog + weekly Rust tests read mainnet through Alchemy | recommended | The key already in `.env.server` (`ALCHEMY_API_KEY_MAINNET` if you have one). Without it the public RPC is used, which rate-limits GitHub's machines now and then (a failed run just retries 30 minutes later). |
| `MAINNET_RPC_URL` | same, any other provider | optional | Use instead of `ALCHEMY_API_KEY` if you prefer a full URL. |
| `D1_BACKUP_PASSPHRASE` | encrypts the backups | **required for the backup** | `openssl rand -base64 32`, and keep a copy outside GitHub (you need it to restore). The database holds report contact details and claim records, and on a public repo this passphrase is all that protects the downloadable artifact, so make it long and random. Without it the backup never runs. |

The backup also needs one repository **variable** (same page, the **Variables** tab, not Secrets):
`D1_BACKUP_ENABLED` = `true`. It is the explicit opt-in: with every secret set but without the variable, the backup
stays off, so adding the Cloudflare token for the watchdog never starts uploading database dumps.

Two files must be committed and pushed after `scripts/go-mainnet.mjs --execute` (both are public data):

- `deploy/mainnet.json` — the workflows below do nothing until it is on `main` with the ALT go-mainnet records.
- `wrangler.jsonc` with the real `cornershop-mainnet` database id (go-mainnet replaces `__D1_MAINNET_ID__` locally). The
  watchdog's D1 reads and `scripts/deploy-mainnet-hotfix.mjs` need it; the backup does not.

## 2. Watchdog every 30 minutes (`.github/workflows/watchdog.yml`)

Runs `node scripts/watchdog.mjs --cluster mainnet --alert --public-log` every 30 minutes (GitHub may start a scheduled
run a few minutes late) and on demand (Actions → Watchdog (mainnet) → Run workflow). It is read-only and holds no key.

Its log is public, so `--public-log` prints the unacknowledged D1 alerts as counts per severity and kind only (for
example `CRITICAL alerts: 1 — admin_changed ×1`), never their messages or refs, which can name wallets, places,
websites and report contacts. It counts the same latest 30 alerts a local run lists, so an older alert ages out the
same way and a critical alert among them still fails the run. The full text is in the Worker's alert email or
webhook, or run the watchdog on your own machine without the flag. The on-chain checks print only public keys,
balances and deadlines.

- **CRITICAL** (exit 2): fails the run, so GitHub emails you (again every 30 minutes while it lasts), and posts to
  your Discord channel when `ALERT_WEBHOOK_URL` is set. Keep it that way: the failed run IS the email. Examples: an
  unregistered admin proposal (the guardian must veto it within 7 days), governance / upgrade authority / attestor /
  guardian changed to a key nobody planned, the Worker's attestor key ≠ the on-chain one, `/api/health` unreachable.
- **Warnings** (exit 1): shown in the run log only (for example "governance not yet Squads vault A" until you finish
  the handover).
- **Exit 3**: the watchdog itself could not run (RPC trouble); the run fails and the next one retries.

**The planned handover is not an alarm.** The expected state comes from `deploy/mainnet.json`
(`scripts/lib/expected.mjs`): governance may be the deployer (before the handover) or Squads vault A (`squadsAVault`,
after), the upgrade authority the deployer or Squads vault B (`squadsBVault`), and the pending
`propose_governance(Squads vault A)` in between is planned even when D1 cannot be read. Any other value is CRITICAL.
For every other planned change, register it first: `node scripts/admin-expect.mjs --env mainnet add …`.

Once both handovers are done, set `governance` to the Squads vault A address and `upgradeAuthority` to the Squads
vault B address in `deploy/mainnet.json` and push it: from then on a move back to the deployer key is CRITICAL too
(until then it only shows as the "not yet Squads vault" warning).

Running it on your own machine instead (or as well), free and outside GitHub:

```bash
node scripts/watchdog.mjs --cluster mainnet --loop 900     # every 15 min; ALERT_WEBHOOK_URL from .env.server
```

The local loop alerts only through `ALERT_WEBHOOK_URL` (without it, criticals are only printed), so keep the GitHub
schedule as the email path. With `--loop`, a CRITICAL result posts at once, the same finding is repeated at most
hourly while it lasts, a RESOLVED message follows when it clears, and three failed runs in a row (RPC down) post too.
The loop never stops on an alert.

### The 60-day schedule rule (public repo)

GitHub disables the scheduled workflows of a public repository after 60 days without repository activity: the
watchdog, the D1 backup and CI (it has the weekly pump.fun run). A disabled workflow stays off for every trigger until
someone enables it again. A disabled watchdog does not fail, it just stops running, so no failed-run email ever
arrives. That is the watchdog's whole alert path, so do not let it lapse:

- Push a commit to `main` at least every 50 days (any change resets the clock, a CHANGELOG line will do). Put a
  recurring reminder in your calendar for every 45-50 days, and each time check that all three are still active:
  `gh workflow list --all` (or Actions → each workflow).
- If one was disabled: `gh workflow enable watchdog.yml` (and `d1-backup.yml`, `ci.yml`), or Actions → the workflow →
  **Enable workflow**. Then run the watchdog once by hand.
- A keepalive workflow that pushes an empty commit each month also works. It needs `contents: write`; pin any action it
  uses to a commit SHA, and check once that its commit really keeps the schedules on before relying on it.
- Do not move the watchdog into the `cornershop` Worker's own cron: it runs elsewhere so that it notices when the Worker
  is down or its attestor key is wrong. A separate Worker with its own alert channel is fine as a second layer, next to
  this schedule, as is the local `--loop` above.

## 3. Daily D1 backup (`.github/workflows/d1-backup.yml`, optional)

Cloudflare's own **D1 Time Travel** already restores the database to any minute of the last 7 days (Workers Free) or
30 days (Workers Paid), at no cost and with no setup: `npx wrangler d1 time-travel restore cornershop-mainnet --env
mainnet --timestamp <ISO time>`. This workflow adds an off-Cloudflare copy. It runs only when all of these are set
(otherwise it skips, green): the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, the
`D1_BACKUP_PASSPHRASE` secret and the repository variable `D1_BACKUP_ENABLED` = `true` (section 1). Every day at
03:17 UTC: `wrangler d1 export cornershop-mainnet --remote` (the database is briefly unavailable to queries while it
exports; at launch size that is seconds), gzipped, **always encrypted** with the passphrase, kept **30 days** as a
workflow artifact (Actions → the run → Artifacts). Only the `.enc` file is uploaded; if the passphrase were missing at
that point, the run deletes the dump and fails instead.

Any signed-in GitHub user can download the artifacts of a public repo, so the passphrase is the only thing protecting
the report contacts and claim records in them. If you do not need a copy outside Cloudflare, leave the backup off.
wrangler comes from `npm ci` (the version and integrity hashes in `package-lock.json`).

Restore (or inspect) a backup:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in cornershop-mainnet-<stamp>.sql.gz.enc -out backup.sql.gz   # asks for the passphrase
gunzip backup.sql.gz
npx wrangler d1 execute cornershop-mainnet --env mainnet --remote --file backup.sql   # into an EMPTY database only
```

## 4. Hotfix: ship a Worker fix after launch (`scripts/deploy-mainnet-hotfix.mjs`)

```bash
node scripts/deploy-mainnet-hotfix.mjs                  # dry run: preflight, build:mainnet, check-bundle, the vars plan
node scripts/deploy-mainnet-hotfix.mjs --execute        # + type HOTFIX, wrangler deploy --env mainnet, smoke test
node scripts/deploy-mainnet-hotfix.mjs --execute --migrate   # also apply new D1 migrations first
```

Why not a plain `npx wrangler deploy --env mainnet`: `wrangler.jsonc` keeps `ALT_ADDRESS` empty (go-mainnet passes it
on the command line) and wrangler deletes every var that is not in the config or on the command line, so a plain deploy
would break every launch. The hotfix passes `ALT_ADDRESS` and `PROGRAM_ID` from `deploy/mainnet.json`, every
`env.mainnet.vars` value, any var that exists only on the live Worker, and a new `BUILD_ID`. It refuses when the live
`ALT_ADDRESS` differs from `deploy/mainnet.json`, when an empty config value would blank a live one, when required
secrets are missing on the Worker, when D1 migrations are pending (unless `--migrate`), and when the git tree has
uncommitted changes (unless `--allow-dirty`). With `--execute` it also refuses while it cannot read the live version,
that version's vars or the D1 migration status (the dry run shows these as warnings): it never deploys blind. It
never touches the program, Config, keys or secrets. Before deploying it prints the rollback command with the version
that is live now; after deploying it runs `scripts/smoke.mjs`.

Its preflight (like go-mainnet's and deploy-devnet's) checks that wrangler is logged in to the AtlasPad Cloudflare
account, by account id (`scripts/lib/wrangler.mjs`). A fork that deploys to its own account sets
`CS_CLOUDFLARE_ACCOUNT_ID` to that account's id.

## 5. Verified program build without local Docker (`.github/workflows/verifiable-build.yml`)

1. Actions → **Verifiable build (shop-vault)** → Run workflow (about 10-20 minutes the first time).
2. Download the artifact `shop-vault-verified-<commit>` from the run and unzip it. It holds `shop_vault.so`,
   `shop_vault.so.sha256` and `build-info.json` (commit, sha256, solana-verify executable hash).
3. `cp <unzipped>/shop_vault.so programs/shop-vault/target/deploy/shop_vault.so`
4. `node scripts/go-mainnet.mjs --dry-run … --verified-artifact <unzipped dir>`: the "verified build" check compares
   hashes instead of rebuilding in Docker, and the deploy uses exactly that file. It also requires the program source
   in your checkout (`programs/shop-vault/src`, `Cargo.toml`, `Cargo.lock`) to be exactly that of the commit CI built,
   so run the workflow on the commit you deploy (after any program change, run it again).

The build runs `solana-verify build` in the Docker image for Solana 4.1.2, pinned in
`programs/shop-vault/Cargo.toml` (`[workspace.metadata.cli]`), the same image a local `--verify` and anyone verifying
the deployed program use.

## 6. go-mainnet evidence rules

`scripts/go-mainnet.mjs` accepts devnet evidence (the e2e run, the graduation run, the accuracy audit in
`scripts/out/`) only when it ran **after the latest devnet deploy record** (a `deploy-devnet` run that deployed the
Worker or the program) and is **at most 7 days old**; otherwise it is flagged stale. Re-run them after your last devnet
deploy:

```bash
npm run e2e:devnet -- --execute
node scripts/accuracy-audit.mjs https://cornershop-devnet.tiejiucai.workers.dev --json
```

pump.fun's devnet migration bot has never migrated our test coin (PumpSwap pool `4MhKxT85…` still did not exist on
2026-10-26), so the `GRADUATE=1` run cannot pass on devnet. Waive it on purpose, with a reason that is recorded in
`scripts/out/go-mainnet-state.json`:

```bash
node scripts/go-mainnet.mjs --dry-run … --waive-graduation "pump devnet migration bot never migrated 4MhKxT85; AMM paths covered by LiteSVM tests on the real pump binaries"
```

The waiver is refused if that pool exists by then (run the graduation test instead).

## 7. pump.fun upgrades

pump.fun upgrades its programs without notice. CI (`.github/workflows/ci.yml`, job `rust`) runs every Monday and on
demand: it builds the program, dumps today's mainnet pump programs read-only and runs the LiteSVM tests against them,
with a warning when a pump binary changed since the committed `programs/shop-vault/tests/fixtures/manifest.json`. After
such a warning, refresh both fixture sets locally and re-run the tests:

```bash
RPC_URL=<mainnet RPC> programs/shop-vault/scripts/dump-fixtures.sh && (cd programs/shop-vault && cargo test)
node src/chain/__fixtures__/capture-devnet.mjs --cluster mainnet && npx vitest run src/chain/mainnet.test.ts worker/pumpMainnet.test.ts
```

**Re-test of 2026-10-26** (read-only, mainnet slot ≈461.66 M), against the fixtures dumped on 2026-10-08:

| Item | Change since 2026-10-08 | Effect on AtlasPad |
|---|---|---|
| pump program | upgraded 2026-10-19 17:47 UTC | none: every instruction we build has the same accounts and args (pump SDK 3.2.0 vs 4.3.1 IDL) |
| pump-amm program | upgraded 2026-10-19 17:47 UTC | none for buy/sell/fee paths (same instruction layouts) |
| pump-fees program | upgraded 2026-10-12 17:40 UTC | none: FeeConfig account byte-identical, fee tiers unchanged |
| mayhem program | unchanged (last deploy 2026-10-02) | — |
| Trade events (pump `TradeEvent`, pump-amm Buy/Sell/Deposit/Withdraw) | new trailing `quote_transfer_fee` u64 (0 on SOL coins) | none: our decoders read fixed offsets; proven on real mainnet events by the new tests |
| pump Global | 1,087 → 1,088 bytes (`max_curve_depth` = 2 appended) | none: decoders read the fixed prefix |
| QuoteControl | 8,108 → 9,068 bytes (more quote mints) | none: our coins are SOL-quoted |
| New error codes | pump 6109/6110, pump-amm 6088 (Token-2022 quote coins) | none for SOL coins |
| Bonding curve / ATA sizes on create_v2 | unchanged (166 / 170 bytes) | launch rent estimate unchanged |
| pump-amm admin instructions | `admin_set_coin_creator` and `set_coin_creator_fee_bps` replaced by `admin_cto_pool` (pump's admin sets a pool's coin creator and its creator fee rate); new `buy_v2` / `sell_v2` / `sweep_*` instructions we do not use | the pool-side twin of `admin_cto` (SPEC T13): the indexer now raises the critical `creator_changed` alert when a graduated coin's pool trade names a coin creator other than its vault, as it already did on the curve; fee figures already count pool fees only while the pool's creator is the vault |

All 112 Rust tests pass against the 2026-10-26 binaries. The pump SDKs moved to 4.3.1 / pump-swap 2.2.0 (a TypeScript API
rework plus nested-quote coins); staying on the pinned 3.2.0 / 2.1.0 is correct for launch.

## 8. Is Cloudflare Workers Free enough at launch?

Measured on the Worker's own end-to-end test flow (fake upstreams, node:sqlite D1) plus real mainnet transactions:

| Limit (Workers Free) | AtlasPad | Verdict |
|---|---|---|
| Worker size | 594 KiB, 184 KiB gzipped | fine |
| Subrequests (fetch) per invocation: 50 | max measured 17 (devnet faucet), cron 14; designed caps: requests ≤ 30 RPC, cron ≤ 36 RPC + 6 Google + 2 price + 1 webhook = 45 | fine |
| D1 queries per invocation: 50 (a batch = 1) | cron 37, `/api/config` 28 (with its fallback indexer run), `/api/market` 25 | fits, little headroom on a busy cron |
| Cron Triggers per account: 5 | devnet 1 + mainnet 1 | fine |
| D1 per-account daily limits on Workers Free: 100k rows written, 5M rows read, 500 MB | shared by devnet and mainnet. Measured 2026-10-27 (`npx wrangler d1 insights cornershop-devnet --env devnet --sort-by writes`): devnet alone wrote ≈ 49k rows and read ≈ 1.05M a day, mostly the cron rewriting unchanged rows every minute and one full scan of `trades` per run. Since then the cron writes only values that moved (an idle run writes 6 bookkeeping rows), devnet's cron runs every 5 min, the `trades` scan uses an index (migration 0004), unused uploads are deleted after 6 h and uploads are capped at 400 a day: expected ≈ 3-5k written a day on devnet, ≈ 12k + ≈ 15 per trade on mainnet (the trade row and its indexes, the coin's market, fees and 24 h figures: ≈ 5,000 trades a day uses up the rest). Reads grow with the number of coins (≈ 7 scans of `coins` per cron run: ≈ 10k rows a day per coin on mainnet) plus visitors | **watch it**: when a limit is hit, every D1 query fails until 00:00 UTC (the whole `/api` stops). Check the Cloudflare dashboard → D1 → `cornershop-mainnet` / `cornershop-devnet` → Metrics (rows read / written) weekly, or `npx wrangler d1 insights <db> --env <env> --sort-by reads` / `--sort-by writes`. Past ≈ 70% of either limit (or ≈ 250 coins), or before any announcement, move to **Workers Paid ($5/month**: 25 billion rows read, 50 million written and 5 GB a month included) |
| CPU per request / per cron: 10 ms | steady state 0.1-4.5 ms per route (co-sign incl. both policy gates and Ed25519 ≈ 2-4.5 ms; Ed25519 itself 0.03 ms); BUT a fresh isolate's first launch evaluates web3.js + the shop-vault client for the second policy gate: ≈ 25-55 ms; the cron decodes ≈ 0.25 ms (warm) to 1 ms (cold) per mainnet transaction | **risk**: Cloudflare tolerates rare overruns, then returns error 1102 |
| Requests: 100,000 per day | every open, visible tab polls the API about 15-30 times a minute (market 5 s, feed 5-20 s, config 60 s, …): 100k ≈ 60-110 visitor-hours a day | **the real limit**: once used up, every `/api` call fails with error 1027 until 00:00 UTC (the map still loads; launching, trading data and claims do not) |
| Workers Logs: 200,000 events/day, 3-day retention | ≈ 1-2 per request | fine at soft-launch traffic |

**Recommendation.** The Free plan works for a quiet soft launch (you and a few testers), on two conditions: set
`POLICY_REFERENCE` to `"0"` in `env.mainnet.vars` (the stricter `worker/policy.ts` gate still checks every
co-signature; only the second, web3.js-based reference gate is skipped, which removes the 25-55 ms cold-start CPU),
and keep the watchdog running (an exhausted daily limit shows up as CRITICAL "/api/health unreachable"). Switch to
**Workers Paid ($5/month)** before you announce AtlasPad anywhere, or the first day any `/api` error 1027 or 1102 shows up
(dashboard → Workers & Pages → cornershop → Metrics → Errors). Paid removes all of the above (10 million requests a
month included, 30 s CPU, 10,000 subrequests, 1,000 D1 queries per invocation) and turns `POLICY_REFERENCE` back on.

## 9. GitHub Actions minutes

Standard GitHub-hosted runners are free and unmetered for public repositories, so none of these workflows costs
anything or runs out. The numbers below matter only if the repo is ever made private again (Free plan: 2,000 minutes
a month):

| Workflow | Runs | Minutes a month |
|---|---|---|
| Watchdog | 48 a day, ≤ 1 minute each (node_modules cached); a run that skips because mainnet is not live yet still bills 1 minute | ≈ 1,440-1,490 |
| D1 backup | daily, ≈ 1 minute | ≈ 30 |
| CI `web` | each push / PR, ≈ 90 s (billed as 2 minutes) | ≈ 2 per push |
| CI `rust` | weekly + when `programs/shop-vault` changes, 5-15 minutes; 1 minute on every other push / PR | ≈ 60-120, plus 1 per push |
| Verifiable build | on demand, 10-20 minutes | per run |

In a private repo that leaves roughly 400 minutes a month for CI: about 130 pushes (3 minutes each: `web` + the
`rust` check). With the default $0 spending limit nothing is ever charged: when the month's minutes run out,
workflows simply stop until the 1st, including the watchdog. If you get close (Settings → Billing → Actions), change
the watchdog's cron to `'0 * * * *'` (hourly, ≈ 720 minutes) and run `scripts/watchdog.mjs --loop 900` locally as well.

## 10. Create the Squads multisigs (`scripts/create-squads.mjs`)

go-mainnet needs two Squads v4 multisigs (`MAINNET-CHECKLIST.md` §4). One command creates both, instead of the Squads
web app:

| | Members | Threshold | Time lock | Config authority |
|---|---|---|---|---|
| **A** governance | three member wallets | 2-of-3 | 0 s | none (autonomous) |
| **B** program upgrade authority | the same three | 2-of-3 | 604,800 s (7 days) | none (autonomous) |

```bash
# 1. dry run: checks everything, simulates both creations, sends nothing
node scripts/create-squads.mjs --cluster mainnet --payer <wallet.json> --members <wallet1>,<wallet2>,<wallet3>
# 2. create them (asks you to type CREATE SQUADS ON MAINNET)
node scripts/create-squads.mjs --cluster mainnet --payer <wallet.json> --members <wallet1>,<wallet2>,<wallet3> --execute
```

- **Members** are the three PUBLIC addresses of wallets on three different devices (hardware wallets are best). They
  must be different from each other, the payer, the attestor, the crank, the deployer and the program id, and on
  mainnet none may be a key file on this machine. Use addresses you can sign with in the Squads app: the script
  refuses program-derived addresses, but it cannot tell whether you still have a wallet's seed.
- **Cost**: about 0.0037 SOL rent (it stays in the two multisig accounts) plus about 0.00003 SOL in fees. The payer
  needs at least 0.009 SOL. Squads charges no creation fee today; the script reads the fee and the treasury from the
  Squads ProgramConfig on every run and refuses a fee above 0.1 SOL.
- **Output**: `deploy/mainnet-squads.json` (multisig + vault addresses, members, signatures; public, commit it) and
  the flags for go-mainnet: `--squads-a <multisig A> --squads-b <multisig B>`. These are the MULTISIG addresses, not
  the vaults: go-mainnet reads each one on chain and derives vault 0 itself (governance goes to vault A, the upgrade
  authority to vault B).
- **Re-runs are safe**: a recorded multisig is verified, never created twice; one that landed while the script
  was interrupted is adopted. Without flags, `node scripts/create-squads.mjs --cluster mainnet` re-checks the recorded
  pair and prints the flags again. To start a new pair, move `deploy/mainnet-squads.json` away first.
- After creating them, open https://app.squads.so with one member wallet and check that both multisigs appear.

Proven on devnet on 2026-10-26 (`deploy/devnet-squads.json`, three throwaway members): A
`8uREw7ywaumQVeo3asLtHaxkZ5fF7frW6EsSmugKMT9Q`, B `HJS8io82jwZLtoFMvGsUsV3vvrH3VhUfArTskyEfRmm7`, both 2-of-3 and
autonomous, and they pass go-mainnet's Squads checks. The instruction is encoded by hand (no Squads SDK) and was checked
against the published Squads v4 IDL, the transaction that landed on devnet, and a read-only simulation against the
mainnet program.
