# AtlasPad runbook

How to run, test, deploy and look after AtlasPad (internal id `cornershop`: Worker, D1 and key names keep it).
Contracts live elsewhere: `INTEGRATION.md` (code shape, wire formats, ops rules H1–H9), `programs/shop-vault/SPEC.md`
(the on-chain program), `MAINNET-CHECKLIST.md` (go-live).

**Safety rules for every command in this file**

- Scripts are **dry runs by default**. Anything that sends a transaction or changes Cloudflare needs `--execute`.
- Scripts never print a secret. If you ever see a key, token, seed phrase or phone number in a terminal, stop, rotate
  it (section 7), and file the bug.
- Only `scripts/go-mainnet.mjs --execute`, run by a person in their own terminal, ever deploys to mainnet. Nobody runs a
  bare `wrangler deploy` or `npm run deploy`.
- The browser never talks to an RPC provider directly; it uses the Worker's `/api/rpc`. Scripts on this machine use the
  public Solana endpoints (or `RPC_URL` if you set one). The Alchemy key lives only in `.env.server` and the Worker.

---

## 1. What runs where

| Thing | Devnet (testing) | Mainnet (real money) |
|---|---|---|
| Worker + site | `cornershop-devnet` → https://cornershop-devnet.tiejiucai.workers.dev | `cornershop` → **https://atlaspad.online** (www.atlaspad.online and https://cornershop.tiejiucai.workers.dev redirect there; today workers.dev serves the Phase-1 demo, replaced at go-mainnet). See §12 "Domain" |
| Build | `npm run build:devnet` → `dist-devnet/` (includes the test wallet) | `npm run build:mainnet` → `dist-mainnet/` (test wallet compiled out) |
| Database | D1 `cornershop-devnet` | D1 `cornershop-mainnet` |
| On-chain addresses | `deploy/devnet.json` | `deploy/mainnet.json` |
| shop-vault program | `6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x` (devnet build, 60 s claim window) | same id, mainnet build, 72 h window |
| Lookup table (ALT) | `AcC53qbWCpZUsSXjaN36h35KyqQQH37oreFnrbZBtB6G` | created by go-mainnet |
| Phone verification | code shown on screen ("Devnet: your code is …") | Twilio voice call |

The demo stays available on both Workers with `?mode=demo`.

## 2. Toolchain and first-time setup

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"   # Solana CLI
node --version             # 22.18 or newer (scripts use built-in TypeScript stripping)
npm ci                     # app + Worker deps (exact pins)
(cd programs/shop-vault/client && npm ci)   # the scripts' Solana libraries
npx wrangler whoami        # must list the AtlasPad account id (scripts/lib/wrangler.mjs; CS_CLOUDFLARE_ACCOUNT_ID for a fork); otherwise: npx wrangler login
```

Secrets you need locally (never commit, never paste into chat): `.env.server` (see `.env.example` for the names) and
the key files in `.keys/` (mode 600). `.env.local` holds the public Google browser key.

## 3. Keys and secrets inventory

| Name | Where it lives | Used for | Never |
|---|---|---|---|
| `ALCHEMY_API_KEY` (or `_DEVNET`/`_MAINNET`) | `.env.server` → Worker secret | the Worker's Solana RPC | in the browser, a URL, a log |
| `GOOGLE_SERVER_KEY` | `.env.server` → Worker secret | Places lookups, link resolving | in the browser |
| `ATTESTOR_SECRET` | `.keys/<cluster>-attestor.json` → Worker secret | co-signs launches and claims only | funded, a fee payer |
| `CRANK_SECRET` | `.keys/<cluster>-crank.json` → Worker secret | pays for `finalize_claim` and fee collection | holds more than ~0.2 SOL |
| `HMAC_KEY` | `.keys/<cluster>-hmac.key` → Worker secret | hashes phone numbers, IPs, claim tokens | reused across clusters |
| `DEV_FAUCET_SECRET` | `.keys/devnet-faucet.json` → devnet Worker only | the devnet test-wallet faucet | anywhere near mainnet (H6) |
| `TWILIO_*`, `TURNSTILE_SECRET_KEY` | `.env.server` → Worker secret | phone calls, bot check (mainnet) | logged |
| `ALERT_EMAIL_TO` | `.env.server` → Worker secret | alert email recipient (an address verified in Cloudflare Email Routing) | in a committed file (wrangler.jsonc, code, docs) |
| `ALERT_WEBHOOK_URL` | `.env.server` → Worker secret | alert delivery to Discord/Slack (optional with `ALERT_EMAIL_TO`) | shared publicly |
| deployer | `.keys/devnet-deployer.json` (devnet) · your wallet file (mainnet) | deploys, initial governance on devnet | used after the Squads handover (mainnet) |
| guardian | `.keys/devnet-guardian.json` (devnet) · **hardware wallet** (mainnet) | pause, cancel claims, veto | in the Worker |
| governance | devnet deployer · **Squads multisig A** (mainnet) | rotations, handovers | the same multisig as the upgrade authority |

Secrets reach Cloudflare only one way: `bash scripts/deploy-devnet.sh --execute --only secrets` (or go-mainnet), which
pipes them into `wrangler secret bulk` through stdin. To set one by hand:
`node scripts/lib/secretPut.mjs NAME --env devnet --from env:NAME --execute` (sources: `env:<.env.server name>`,
`key:<.keys file>.json`, `b64file:<.keys file>.key`).

## 4. Local development

```bash
node scripts/dev-vars.mjs devnet                                        # writes .dev.vars.devnet (mode 600), names only printed
npx wrangler d1 migrations apply cornershop-devnet --env devnet --local
npm run worker:devnet          # wrangler dev --env devnet on :8787
npm run dev:devnet             # Vite on :5173 with VITE_CLUSTER=devnet VITE_TEST_WALLET=1, /api proxied to :8787
```

`node scripts/smoke.mjs http://127.0.0.1:8787 --cluster devnet` smoke-tests the local Worker.

## 5. Devnet: funding, deploying, rolling back

### Funding

Everything on devnet is paid by the **deployer** `GNm79FtEQQx41LYfVbU9xDQaFDRVQyZ8q85DAWoHe6Bw`, which tops up the
others: crank (target 0.2 SOL), dev faucet (target 3 SOL), and the e2e keys (launcher, buyer, owner).

```bash
node scripts/fund-devnet.mjs                 # balances + plan
node scripts/fund-devnet.mjs --execute       # requestAirdrop 1 SOL × n until the deployer has 8 SOL
node scripts/fund-devnet.mjs --roles --execute   # top up crank + faucet from the deployer
```

The public airdrop is often dry. Then open https://faucet.solana.com (network **devnet**, log in with GitHub for more),
paste the deployer address above and request SOL until it holds about 8 SOL. Graduation tests need about 3.4 SOL extra.

### Deploy or redeploy the devnet Worker

```bash
bash scripts/deploy-devnet.sh                    # dry run: preflight + plan, sends and changes nothing
bash scripts/deploy-devnet.sh --execute          # everything not done yet, idempotent
bash scripts/deploy-devnet.sh --execute --only build,deploy,smoke    # just ship new code
```

Steps: preflight → fund → program → config → alt → record → d1 → roles → build → secrets → deploy → smoke. It
deploys only `cornershop-devnet` (`wrangler deploy --env devnet`), passes `ALT_ADDRESS` and `BUILD_ID` with `--var`,
and refuses if `wrangler.jsonc` `env.devnet` is not exactly the devnet Worker. Secrets go **before** the deploy because
`env.devnet` declares `secrets.required`; on a brand-new Worker, wrangler first creates an empty placeholder, which the
deploy replaces seconds later. A JSON record of each run goes to `scripts/out/`.

Program upgrades on devnet: rebuild (`programs/shop-vault/scripts/build.sh`), then
`bash scripts/deploy-devnet.sh --execute --only program --upgrade-program`.

### Roll back

- Worker: `npx wrangler deployments list --env devnet`, then `npx wrangler rollback --env devnet` (previous version) or
  `npx wrangler rollback <version-id> --env devnet`. Secrets and D1 are not rolled back.
- D1: `npx wrangler d1 time-travel info cornershop-devnet --env devnet`, then
  `npx wrangler d1 time-travel restore cornershop-devnet --env devnet --timestamp <unix or RFC3339>` (7 days back on
  Workers Free, 30 on Workers Paid; mainnet the same with `cornershop-mainnet --env mainnet`).
  The registry can always be rebuilt from the chain, because the chain is the source of truth.

## 6. Testing on devnet

### Wallet settings

Coins and SOL on devnet are test tokens with no value. Wallets must be switched to devnet, or they show warnings or
wrong balances (menu labels vary by version):

- **Phantom:** Settings → Developer Settings → Testnet Mode on → Solana: Devnet.
- **Solflare:** Settings → General → Network → Devnet.
- **Backpack:** Settings → Preferences → Solana → RPC connection → Devnet.

Get test SOL from https://faucet.solana.com, or from the site's DEVNET chip → "Get test SOL" (the test wallet gets it
from our faucet automatically).

### Automated checks (run these after every deploy)

```bash
node scripts/smoke.mjs https://cornershop-devnet.tiejiucai.workers.dev --cluster devnet   # read-only, ~10 s
npm run e2e:devnet -- --execute          # full API-level flow with local keys, ~3 min
GRADUATE=1 npm run e2e:devnet -- --execute   # + graduation to PumpSwap (needs ~3.4 SOL extra, up to 30 min)
node scripts/accuracy-audit.mjs https://cornershop-devnet.tiejiucai.workers.dev --json   # every number vs chain
node scripts/check-bundle.mjs dist-devnet --cluster devnet           # sizes, chunking, leak scan
```

`e2e:devnet` launches `cornershop-test:e2e-<id>`, checks a tampered transaction is refused, refuses a duplicate launch,
buys and sells (both appear in the feed within 5 s), checks fees waiting equal the summed on-chain creator fees to the
lamport, claims with the on-screen code, waits out the 60 s window, lets the cron finalize, and withdraws exactly the
fees to the owner. Reports with signatures and timings go to `scripts/out/`.

### Manual test with a real wallet (Phantom, then Solflare)

1. Open https://cornershop-devnet.tiejiucai.workers.dev. The top right shows **DEVNET**.
2. Connect a devnet wallet with at least 1 test SOL.
3. Click a real café on the map → **Launch** → name, ticker, art → first buy **0.1 SOL** → accept the one-time
   risk and Terms sheet (first transaction in this browser) → approve in the wallet.
   Within 7 seconds the coin is on the map with price and market cap. "View tx" opens Solscan (devnet).
4. From a **second** wallet: buy 0.1 SOL, then sell 50%. Balance, holdings, Live feed and "fees waiting" update.
5. On the coin's shop: **I own this business** → the code appears on screen ("Devnet: your code is …") → enter it →
   **Request claim** (approve) → after 1 minute **Finalize** (or wait for the cron) → **Withdraw**. The wallet receives
   the fees.
6. Every Solscan link opens the right devnet page. Pump.fun and DexScreener links are hidden on devnet.
7. Add `?mode=demo`: the old demo, with no `/api/rpc`, `/api/coins` or `/api/market` calls in the network tab.

The **Devnet Test Wallet** (devnet builds only) signs automatically and gets test SOL from our faucet. Use it for quick
runs and automated browser tests; use Phantom and Solflare for the sign-off.

## 7. Rotating keys and secrets

General pattern: put the new value in `.env.server` (or create the new key file), then
`bash scripts/deploy-devnet.sh --execute --only secrets --resync-secrets` (devnet) or
`node scripts/lib/secretPut.mjs NAME --env mainnet --from <source> --execute` (mainnet). Then revoke the old value at
the provider and run the smoke test.

| Secret | How | Notes |
|---|---|---|
| Alchemy | create a new key in the Alchemy app, update `.env.server`, push the secret, delete the old key | do it at once if a key shows up anywhere public |
| Google server key | Cloud Console → Credentials → rotate/regenerate `cornershop-server`, push, delete the old | browser key: update `.env.local`, rebuild, redeploy |
| HMAC | delete `.keys/<cluster>-hmac.key`, re-run `--execute` (a new one is generated), push | resets per-phone / per-IP rate-limit history only; active claim tokens stop working |
| Twilio auth token | Twilio console → rotate the secondary token, push, promote, revoke the old | |
| Turnstile | rotate the secret in the Cloudflare dashboard, push | |
| Crank | create a new crank key, fund it, push `CRANK_SECRET`, sweep the old crank's SOL back | the crank has no powers, only pays fees |
| Dev faucet (devnet) | new `.keys/devnet-faucet.json`, fund, push | |

### Attestor rotation (SPEC §5.8): planned, or after a compromise

The attestor only co-signs launches and claims. Rotation needs governance (proposes) and the guardian (consents).

1. If compromised: the **guardian pauses launches** (`set_paused(1)`). Trading, claims and withdrawals keep working.
2. List rogue claims: `node scripts/claims-admin.mjs --env <env> list`. The guardian **cancels every rogue pending
   claim before its unlock time**: `node scripts/claims-admin.mjs --env <env> cancel <placeId>` (devnet: signs and
   sends with `--execute`; mainnet: prints an unsigned transaction for the hardware guardian).
3. Create the new attestor key, then **register the plan**:
   `node scripts/admin-expect.mjs --env <env> add --kind attestor-proposed --key <new pubkey> --note "attestor rotation"`
   (and `attestor-applied`).
4. Governance proposes (`propose_attestor`, Squads A on mainnet); the guardian consents (`accept_attestor`), which
   applies at once. The old attestor cannot interfere.
5. `node scripts/lib/secretPut.mjs ATTESTOR_SECRET --env <env> --from key:<cluster>-attestor.json --execute`, update
   `deploy/<cluster>.json` (`attestor`), and check `/api/health` shows `attestor: ok`.
6. The guardian unpauses (`set_paused(0)`).
7. A **7-day probation** starts automatically: claims requested now unlock only after probation + window, and the shop
   pages show the probation banner (SPEC §8.6). Tell verified owners to withdraw.

Guardian or governance rotations follow SPEC §5.8 ("Compromised guardian", "Governance handover"). Always register the
proposal with `admin-expect.mjs` first.

## 8. Alerts: what they mean and what to do

Alerts come from the Worker's per-minute monitor (D1 `alerts` table) and from `scripts/watchdog.mjs` (run it every 15
minutes from a machine that is not the Worker; exit code 2 = critical).

Where they reach you (both free; set either or both):

- **Email**: `ALERT_EMAIL_TO` in `.env.server` (pushed as a Worker secret by go-mainnet / `deploy-devnet.sh`). The
  Worker's `ALERT_EMAIL` binding (Cloudflare Email Routing on `atlaspad.online`) sends each warn/critical alert and
  the owner alerts (claims, disputes, reports, opt-outs; at most 30 an hour per lane) from `alerts@atlaspad.online`,
  subject `[AtlasPad mainnet] WARN owner_claim: …`. The address must be a verified destination address (dashboard →
  atlaspad.online → Email → Email Routing → Destination addresses); Cloudflare refuses any other. Change it in
  `.env.server`, then `node scripts/lib/secretPut.mjs ALERT_EMAIL_TO --env mainnet --from env:ALERT_EMAIL_TO --execute`.
  No email arriving: check the Worker logs for `alert_email.failed`, and your inbox's spam folder.
- **Discord/Slack**: `ALERT_WEBHOOK_URL` gets the same text.
- **Watchdog**: on GitHub Actions a critical finding fails the run and GitHub emails you (the watchdog cannot use the
  Worker's binding); with `ALERT_WEBHOOK_URL` set it also posts to Discord.

Every alert is in D1 `alerts` whatever the channels do: `node scripts/watchdog.mjs --cluster mainnet` lists the
unacknowledged ones.

| Alert | Severity | Meaning | Do this |
|---|---|---|---|
| `AdminChanged` with no matching `admin_expectations` row | critical | someone proposed or applied an admin change we did not plan | Attestor/guardian proposal: the **guardian vetoes** (`cancel_attestor_proposal` / `cancel_guardian_proposal`) before the eta the watchdog prints (7 days). Guardian-proposed governance recovery: **governance withdraws** it. Then treat governance or the guardian as compromised (SPEC T10c/T11). |
| `Registered` with no coin or reservation | critical | a launch was co-signed outside our flow: possible attestor key misuse | Compromised-attestor procedure (section 7). The coin still pays its shop; hide it if the name is abusive. |
| `ClaimRequested` with no claims row | critical | a claim was co-signed outside our flow | Guardian cancels it before unlock ("Guardian: cancel a wrong claim / pause launches" below), then the compromised-attestor procedure. |
| `ClaimCancelled` | warn | a pending claim was cancelled | Check who (role in the event): guardian/governance = us; claimant = they gave up; owner = probation claim. |
| `claim_website_verified` / `owner_cosign` | warn | a website code was found / the attestor co-signed a claim. The claimant can now send it on chain, with or without telling the site | Nothing yet if you expected it. If no `owner_claim` follows within minutes, run `node scripts/claims-admin.mjs --env mainnet list`. A "multi-tenant host" note (a `github.io`, `netlify.app`, ... subdomain) means anyone could have signed up for that site: check it is the business's own before unlock. |
| `claim_pending_onchain` | warn / critical | the vault sweep found a claim pending on chain that no `/api/claim/confirm` recorded. warn: the site co-signed it over 10 min ago and its browser never confirmed it; critical: the site never co-signed it (possible attestor misuse) | Run `claims-admin.mjs list`; check the claimant and the website; cancel before unlock if it is wrong ("Guardian: cancel a wrong claim" below). Critical: then the compromised-attestor procedure (section 7). |
| `monitor_backlog` | warn | the program monitor is reading transactions more than 10 min late (a flood of transactions naming the program, or missed cron runs) | Claims are still caught by the vault sweep. Run `claims-admin.mjs list` until it clears; check the Workers logs for skipped runs. |
| `curve.creator ≠ vault` on one of our coins | critical | pump.fun's `admin_cto` redirected that coin's creator fees | Section 11, "pump.fun took over a coin". |
| price sources differ by > 2% | warn | Jupiter and Pyth disagree; we keep Jupiter | If it lasts > 10 min, USD values hide automatically; check the feeds. |
| key string found in an RPC response | critical | the proxy redacted our Alchemy key from a response | Rotate the Alchemy key now (section 7), then find the cause. |
| attestor mismatch (`/api/health` `attestor`) | critical | the Worker's key is not the on-chain attestor; co-signing is off (503) | Push the right `ATTESTOR_SECRET`, or finish the rotation. |
| indexer stale (`/api/health` `indexer`) | warn | the cron has not run for 3 min | Check Workers logs; see "Cron limits" below. |
| `crank low` / `CRITICAL crank nearly empty` (watchdog) | warn below 0.02 SOL, critical below 0.005 SOL | the crank (`crank` in `deploy/<cluster>.json`) pays every `finalize_claim` and fee-collect fee and pump's creator-vault rent per coin; empty, claims stop finalizing and fees stop being collected | Send about 0.1 SOL to the crank address the watchdog prints, from any wallet (Phantom is fine). go-mainnet funds it with 0.1 SOL at launch. |
| faucet low (devnet) | info | the dev faucet holds < 0.3 SOL (0.05 fee reserve + 0.25 minimum payout): airdrops refuse (503 `faucet_empty`, `/api/config` `features.faucet: false`, health `faucet: stale`); the Devnet Test Wallet itself stays available | `node scripts/fund-devnet.mjs --roles --execute` |
| probation active | info | an attestor changed in the last 7 days | Expected after a rotation; keep the banner on, tell owners. |
| `google_budget` | warn | the day's 3,000 paid Google lookups (all visitors together: launch eligibility checks, launch prepare, listing lookups and claim contact lookups) are used up; until midnight UTC new lookups answer "Lookups are busy today" (cached answers still work) | Check the Workers logs and D1 `rate_counters` (`elig:ip:*`, `listing:ip:*`, `prepare:ip:*`, `website:ip:*`) for one client hammering it. Real demand: raise `GOOGLE_LOOKUPS_PER_DAY` in `worker/google.ts` (mind the Google bill) and redeploy. Relief for the rest of today without a deploy: `npx wrangler d1 execute cornershop-mainnet --env mainnet --remote --command "UPDATE rate_counters SET count = 0 WHERE key = 'google:global'"`. |
| `sanctioned_wallet` | warn | a launch, claim payout or `/api/rpc` send named a wallet on the OFAC list; it was refused, nothing was co-signed or relayed. Signatures are not checked at that point, so anyone can trigger this by pasting a listed address: it is not proof the wallet's owner was here | Keep the alert (date, address, what) for your records. Treat it as a lead, not proof: check on an explorer whether that wallet signed anything near that time, then ask your lawyer whether it must be reported (OFSI, OFAC). See "Sanctions" in section 9. |

**Pre-registering planned changes.** Before *any* planned proposal (rotation, handover, pause for maintenance), run
`node scripts/admin-expect.mjs --env <env> add --kind <kind> --key <pubkey> --note "<why>"`. List them with
`… list`. Without that row, the monitor treats the change as an attack.

### Guardian: cancel a wrong claim / pause launches

The mainnet guardian is a wallet you control on its own device. `scripts/guardian.mjs` serves a small page from the
machine you run the scripts on that builds the guardian's transaction (`cancel_claim` or `set_paused`), simulates it,
checks that the connected Phantom account **is** the guardian recorded on chain, and then lets Phantom sign and send it.
The script never holds the guardian key, and the page refuses anything that would fail (nothing pending, unlock time
passed, already paused).

Use it to **cancel a claim** you believe is wrong (an owner-claim alert you did not expect, a dispute, a
`ClaimRequested` with no claims row) **before its unlock time** (72 hours after the request), and to **pause launches**
during an attestor incident (trading, claims and withdrawals keep working) and unpause afterwards.

Keep about **0.01 SOL in the guardian account**: it pays each transaction's network fee (0.000005 SOL). With nothing in
it the page says `AccountNotFound: the guardian wallet needs a little SOL`.

On mainnet, with the guardian in Phantom on its own device:

1. Find the place id: `node scripts/claims-admin.mjs --env mainnet list` (the claim alert names it too).
2. On the scripts machine: `node scripts/guardian.mjs --cluster mainnet --lan cancel <placeId>` (or `pause`, or
   `unpause`). It prints `http://127.0.0.1:8790/` for that machine and `http://<Wi-Fi address>:8790/` for the guardian
   device.
3. On the guardian device, on the **same network** as the scripts machine, open Phantom → **Browser** (the globe tab)
   and type `http://<Wi-Fi address>:8790/`. The page is plain http, so use the safest network: best, a hotspot from the
   guardian device that the scripts machine joins; otherwise only a private Wi-Fi you trust, never a shared or public
   one. If the firewall asks whether node may accept incoming connections, allow it. Phantom must **not** be in Testnet
   Mode (with it on, a mainnet action fails with "Blockhash not found").
4. Check the red **MAINNET** badge and the guardian address. Tap **Connect Phantom** and approve. The page must say
   **✓ this is the guardian**; if not, switch to the guardian account in Phantom and tap Connect again.
5. The action is prefilled. Tap **Review**: a cancel shows the pending claimant and its unlock time; every check ends
   with **✓ simulated OK**.
6. Tap **Sign and send with Phantom** and approve within about a minute. Phantom's screen must show no balance change
   except the network fee; if it shows SOL or tokens leaving, reject it. The page shows the signature (Solscan link)
   and then **✓ confirmed**.
7. Check: `node scripts/claims-admin.mjs --env mainnet list` no longer shows that pending claim (the Worker sends a
   `ClaimCancelled` warn alert, and its cron marks the claim row cancelled after the unlock time). Run
   `node scripts/watchdog.mjs --cluster mainnet`. For a pause, the site shows launches paused within a minute.

If the guardian device cannot open the page (another network, or Phantom's in-app browser will not load it), run the
same command without `--lan` on a second computer that holds no other AtlasPad key (the script needs no key files) and
open `http://127.0.0.1:8790/` there, in a browser whose Phantom extension holds the guardian (best: a hardware wallet
connected to it). Never import the guardian's private key into a machine that holds other AtlasPad keys.

Rehearse once on devnet before you need it: turn on Phantom → Settings → Developer Settings → Testnet Mode (Solana
Devnet), and use a throwaway Phantom account that holds the devnet guardian (`.keys/devnet-guardian.json`, a devnet-only
test key: import it with Import Private Key) and 0.01 devnet SOL. Then `node scripts/guardian.mjs --cluster devnet --lan
pause`, sign from the guardian device, and `unpause` the same way (the devnet watchdog warns while launches are paused). Then
turn Testnet Mode off again. The guardian pays each action's network fee, so keep about 0.01 SOL in it (the watchdog
warns below 0.001 SOL). The page does cancel, pause and unpause only: vetoing an attestor or guardian proposal
(`cancel_attestor_proposal` / `cancel_guardian_proposal`, SPEC §5.8) is a separate guardian transaction that this page
does not build.

## 9. Moderation and takedown requests

Moderation hides a coin in **our** UI only (map, lists, feed, search). The coin itself lives on Solana and keeps paying
its shop; we cannot delete it.

```bash
node scripts/moderate.mjs --env mainnet --reports                 # recent reports and opt-outs (contact hidden)
node scripts/moderate.mjs --env mainnet --reports --show-contact  # when you need to reply
node scripts/moderate.mjs --env mainnet --hide <mint> --execute   # hide one coin (abuse, impersonation, slurs)
node scripts/moderate.mjs --env mainnet --unhide <mint> --execute
node scripts/moderate.mjs --env mainnet --optout <placeId> --execute   # the business asked to be removed
node scripts/moderate.mjs --env mainnet --hidden                  # what is hidden now
```

Takedown process:

1. Read the request (site report form, email). Check the requester plausibly speaks for the business: email at the
   business's own domain, the listing phone, or a photo in the shop.
2. Hide the coin (`--optout <placeId>` for a business opt-out, `--hide <mint>` for abuse). It disappears within about
   30 seconds (cache lifetimes).
3. Reply: the coin is hidden on AtlasPad; the on-chain token cannot be deleted; its creator fees stay reserved for the
   verified owner, who can still claim them.
4. Google content (photos, reviews) is never stored by us; it is shown live from Google. Requests about it go to Google.
5. Keep a short log (date, place, action) for the legal record. Delete contact details you no longer need.

Hiding does not stop `/img/<id>` and `/meta/<id>.json` (the coin's art and metadata JSON, which wallets and pump.fun
read). For abusive art or text, blank them too (`<mint>` as above). The rows stay (the registry's foreign keys point at
them, so a DELETE fails); the art becomes an empty file and the JSON `{}`. Name and ticker are on-chain and stay.
Copies that wallets, explorers or pump.fun already cached are theirs to drop:

```bash
npx wrangler d1 execute cornershop-mainnet --env mainnet --remote --command "UPDATE assets SET bytes = x'' WHERE id IN (SELECT image_id FROM coins WHERE mint = '<mint>' UNION SELECT m.image_id FROM metadata m JOIN coins c ON c.metadata_id = m.id WHERE c.mint = '<mint>')"
npx wrangler d1 execute cornershop-mainnet --env mainnet --remote --command "UPDATE metadata SET json = '{}', description = '' WHERE id = (SELECT metadata_id FROM coins WHERE mint = '<mint>')"
```

TODO: a `blocked` flag on `assets` / `metadata` that `serveImage` / `serveMeta` (worker/metadata.ts) answer 410 for,
set by `scripts/moderate.mjs --hide`, so this needs no hand-written SQL.

### Sanctions: geo-block and wallet screening

On devnet and mainnet the Worker refuses, with HTTP 451 (`worker/geo.ts`, `worker/sanctions.ts`):

- **Visitors** from North Korea, Iran, Syria, Cuba, Russia and Belarus, and from Crimea (UA-43), Sevastopol (UA-40),
  Donetsk (UA-14) and Luhansk (UA-09), located by Cloudflare from their IP. Pages show a static "not available in your
  region" page; API calls answer `region_blocked`. `/terms`, `/privacy`, `/api/health` and `/api/config` stay open.
  A VPN gets around any IP block; the Terms must say the site may not be used from these places.
- **Businesses** in those places: launch prepare, claim call and the website code answer `place_region_blocked`. A
  launch is also refused when Google gives no country for the place (we never guess); a claim is not.
- **Wallets** on the OFAC SDN list (`worker/data/sanctioned-wallets.json`): no launch, no claim payout, and `/api/rpc`
  never relays a transaction that contains one anywhere in its bytes (fee payer, accounts, instruction data; accounts
  loaded from a lookup table are not resolved). This does not depend on the visitor's location.

Changing the lists needs no code change: set `BLOCKED_COUNTRIES` (ISO 3166-1 codes, CSV) and `BLOCKED_REGIONS`
(ISO 3166-2 codes, CSV) in `wrangler.jsonc` under `env.<env>.vars`, then redeploy. Unset or blank = the defaults above;
`none` = an empty list. `GEO_BLOCK=off` turns every location rule off (emergencies only; wallet screening stays on).
Google gives region names, not ISO codes: the four Ukrainian regions are recognised by name, other regions only where
Google's short code is the ISO one (US states, Canadian provinces, Australian states). Test a new region on devnet.

Refresh the OFAC list **at least monthly** and whenever OFAC announces crypto designations:

```bash
node scripts/update-sanctions.mjs            # downloads Treasury's sdn_advanced.xml (~130 MB, a few minutes)
node scripts/update-sanctions.mjs --check    # exit 1 when the committed list is out of date (writes nothing)
```

Then commit `worker/data/sanctioned-wallets.json` and redeploy; the list is built into the Worker. If the download
fails, fetch the file with `curl -L -o sdn_advanced.xml <url printed by the script>` and pass `--file sdn_advanced.xml`.

## 10. Claims and disputes

```bash
node scripts/claims-admin.mjs --env mainnet list               # active claims + on-chain pending, unlock times
node scripts/claims-admin.mjs --env mainnet cancel <placeId>   # prints the guardian's unsigned cancel transaction
```

A claim is public for the claim window (72 h on mainnet) before it can be finalized. If the real owner disputes a claim
(for example, the listing phone number was hijacked), check the evidence and have the **guardian** cancel it before the
unlock time. Governance can cancel at most 2 claims per shop, ever, so the guardian is the normal path. The claimant's
nonce is used up, so a cancelled claim needs a fresh verification.

## 11. Incidents

### pump.fun took over one of our coins (`admin_cto`, SPEC T13)

Future creator fees of that coin no longer go to the shop's vault. What is already in the vault stays withdrawable.

1. Confirm: the bonding curve's `creator` (or the pool's coin creator after graduation) is no longer the vault.
2. Run the fee crank for that coin at once (collect everything accrued into the vault). The cron does this every 6 hours
   when there is ≥ 0.01 SOL to collect.
3. Tell the verified owner (if any) to withdraw. Mark the coin in the UI (hide, or show a notice).
4. Contact pump.fun and ask them to exempt AtlasPad shop vaults. Record the incident.

### Compromised attestor

See section 7, "Attestor rotation". Pause first, cancel rogue claims, rotate, unpause.

### The Worker is broken after a deploy

`npx wrangler rollback --env <devnet|mainnet>` restores the previous version in seconds. Then smoke-test. On mainnet
the first rollback after go-mainnet returns to the **demo**; go-mainnet prints that version id before deploying.

### Alchemy key exhausted or leaked

Symptoms: `/api/health` `alchemy` not ok, 503s, empty prices. Rotate or upgrade the plan (section 7). Check
usage in the Alchemy dashboard. Devnet fits the free tier at test traffic; mainnet needs a paid plan.

### Cron limits

The Worker runs its indexer from a cron: every minute on mainnet, every 5 minutes on devnet (devnet shares the account's
Workers Free D1 budget of 100k rows written and 5M read a day with mainnet; docs/OPS-AUTOMATION.md §8). If a deploy fails because the account's cron-trigger limit is reached,
remove a cron from another Worker or upgrade to Workers Paid. Without the cron the indexer still runs on demand (from
`/api/market`, `/api/feed`, `/api/config`, `/api/health` and `/api/claim/status` requests, at most once every 1.5 cron
periods: 90 s on mainnet, 7.5 min on devnet), so
the site keeps working while anyone has it open, and pending claims are finalized on the next such request; anyone can
also press **Finalize** in the UI. With nobody visiting, `/api/health` reports `indexer: stale` (the health request itself
kicks a run). An external uptime pinger on `/api/health` every minute keeps it fresh. The free plan's 10 ms CPU and 50
subrequest limits may slow the cron on devnet; Workers Paid is required for mainnet.

**Is the cron firing?** `npx wrangler tail cornershop-devnet --format pretty` shows a `*/5 * * * *` line every 5 minutes
when it is (mainnet: `* * * * *` every minute). Integrator note (2026-10-08): on the new `cornershop-devnet` the schedule is registered (Cloudflare API: `* * * * *`,
script handlers `fetch, scheduled`; the account has only 2 crons) but **no scheduled invocation was observed in the first
~35 minutes** (tail and analytics), even after `wrangler triggers deploy --env devnet` and re-creating the schedule, while
another Worker's cron fires every minute. If it still does not fire: check Workers → cornershop-devnet → Settings →
Triggers in the dashboard, then upgrade to Workers Paid or ask Cloudflare support. The request-driven fallback above
covers the gap meanwhile (the 2nd e2e run's claim was finalized by it 38 s after unlock).

### Alchemy credit monitoring

Check the Alchemy dashboard weekly (compute units used vs plan). The Worker caps upstream calls (2-second shared cache
on `/api/market`, ≤ 40 calls per cron run). If usage grows fast, look for one IP hammering `/api/rpc` (rate-limit
hits in Workers logs) before buying more credits.

## 12. Going to mainnet

Follow `MAINNET-CHECKLIST.md`. In short:

```bash
node scripts/go-mainnet.mjs --create-keys --dry-run --deployer <wallet.json> --guardian <ledger address> \
  --squads-a <multisig A> --squads-b <multisig B> --verify --record
# fix every ✗, tick every box, then in your own terminal:
node scripts/go-mainnet.mjs --execute --deployer <wallet.json> --guardian <ledger address> --squads-a <multisig A> --squads-b <multisig B>
```

go-mainnet deploys the program, initializes it, creates the ALT, funds the crank, creates D1, pushes the secrets, builds,
deploys `cornershop` (replacing the demo) and smoke-tests it. Then it prints the follow-ups: hand governance to Squads A
(`--propose-governance`), move the upgrade authority to Squads B, start the watchdog, do one real launch for a business
you own with first buy 0, and after 30 quiet days make the program immutable.

### Domain: atlaspad.online

- The site lives at **https://atlaspad.online**, the `PUBLIC_ORIGIN` of `wrangler.jsonc` `env.mainnet`. Every coin's
  metadata link is written on-chain with it, so it never changes after the first mainnet launch.
- **Keep the domain forever.** Turn on auto-renew and the registrar lock for atlaspad.online. If it ever lapsed, every
  coin's on-chain metadata link would break, and whoever registered it next could serve any name, image or link for
  every AtlasPad coin.
- `atlaspad.online` and `www.atlaspad.online` are Workers **Custom Domains** of the `cornershop` Worker
  (`env.mainnet.routes`, `custom_domain: true`) on the atlaspad.online zone of this Cloudflare account. The first
  `wrangler deploy --env mainnet` (go-mainnet step E8) creates their DNS records and certificates. go-mainnet's preflight
  checks (read-only DNS) that the zone's nameservers are Cloudflare's. go-mainnet runs wrangler without a terminal, so an
  `A`, `AAAA` or `CNAME` record already on `atlaspad.online` or `www` (a parking page, say) is replaced without asking;
  look at DNS → Records first if one of them matters. The email-forwarding `MX` and `TXT` records for
  hello@atlaspad.online are not touched. wrangler uploads the Worker before it attaches the domains: if E8 fails after
  "Uploaded cornershop", the new Worker is already live on workers.dev (redirecting to atlaspad.online), so fix the
  domain and re-run, or `npx wrangler rollback --env mainnet`.
- One canonical origin (`worker/canonical.ts`): on `www.atlaspad.online`, `cornershop.tiejiucai.workers.dev`, plain
  `http://` and Cloudflare's alternate HTTPS ports, page requests (GET/HEAD outside `/api`) get a **301** to the same
  path and query on https://atlaspad.online, and `/api/*` requests get a JSON **421** `wrong_host` that names the right
  address. So `env.mainnet` runs the Worker first for every path except the content-hashed `/assets/*` (those stay free
  static-asset hits). Never disable workers.dev: old links keep working through the redirect. Devnet is unaffected (its
  `PUBLIC_ORIGIN` is its workers.dev host).
- Check it after go-live: `node scripts/smoke.mjs --cluster mainnet` smoke-tests atlaspad.online and checks that www
  and workers.dev redirect. `node scripts/watchdog.mjs --cluster mainnet` checks atlaspad.online's `/api/health`. Point
  any uptime pinger at `https://atlaspad.online/api/health` too (on workers.dev the API answers 421).
- Outside services that name the site: the Google browser key allows the referrer `https://atlaspad.online/*` (go-mainnet
  asks you to confirm it); the Turnstile widget (when used) lists the hostname `atlaspad.online` (a widget made for the
  workers.dev host fails there); a Privy app (when `PRIVY_APP_ID` is set) allows the origin `https://atlaspad.online`.
- Website verification: owners add `<meta name="atlaspad-verify" content="…">` to their home page's `<head>`, or publish
  `/.well-known/atlaspad.txt`. The older `cornershop-verify` tag and `/.well-known/cornershop.txt` are still accepted.
- Phone verification, when you add Twilio: name the Verify service **AtlasPad** (the name callers hear), code length 6,
  voice channel on, voice geo permissions for every country you serve.
- The share card `public/og.png` is rendered from `design/og-card.html` by `node scripts/og-card.mjs` (local Chrome).
