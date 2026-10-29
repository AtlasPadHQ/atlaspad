# Changelog

Every patch gets an entry here, a commit, and a version tag (`vMAJOR.MINOR.PATCH`). Newest first.

## v0.7.0 — 2026-10-29 · first public release
AtlasPad is open source: https://github.com/AtlasPadHQ/atlaspad. This is the repository's first public commit; the
earlier history stays private. The shop-vault program source is unchanged from the verified mainnet build (sha256
91b91048…). Ships as a hotfix deploy (Worker and site); no program or migration change.

Open source
- Licences: AGPL-3.0-or-later for the site, Worker, scripts and docs; Apache-2.0 for programs/shop-vault; the SIL OFL
  1.1 for the bundled fonts. The AtlasPad name and logos are not licensed (TRADEMARKS.md). NOTICE lists third-party
  material.
- The site links to the code: "GitHub" on the desktop rail, "Source code on GitHub" in the mobile menu, and the Help
  panel ("AtlasPad is open source").

Repository, scripts and workflows
- Deploy scripts check the wrangler login by Cloudflare account id (`CS_CLOUDFLARE_ACCOUNT_ID` for a fork), not by
  account name.
- The watchdog workflow runs `--public-log`: D1 alerts print as counts per severity and kind. The D1 backup needs
  `vars.D1_BACKUP_ENABLED=true` and `D1_BACKUP_PASSPHRASE`, and uploads only the encrypted file.
- Every workflow action is pinned to a commit SHA and CI has a read-only token. Dependabot and issue templates;
  security reports go to a private advisory.
- .gitignore: a key-file safety net, and research/, videos/, marketing/, BRIEF.md and design/* (except og-card.html)
  stay out of the public tree.
- README for public readers, SECURITY.md and TRADEMARKS.md; docs without operator, legal or key-custody details.
  Terms §6: governance is a key being moved to a multisig.
- A guard test (scripts/test/email.test.mjs): no published file holds a home-directory path, a personal email address,
  the operator's handle or name (compared by sha256), the personal GitHub account or a Google API key.

Worker security fixes
- Claim alerts. Every co-sign sends `owner_cosign` (warn, once a day per place, nonce and wallet), since a claimant
  can send the co-signed `request_claim` through any RPC and never call `/api/claim/confirm`. The vault sweep raises
  `claim_pending_onchain` for a claim pending on chain that no confirm recorded, judged on the claims rows (warn:
  co-signed over 10 min ago and never confirmed; critical: never co-signed), in at most three D1 batches a cron run
  and one message however many it finds (a count, the never co-signed first, at most four listed).
  The program monitor raises `monitor_backlog` when it reads transactions more than 10 min late (15 min on devnet),
  dated by the signature page, so a flood of failed transactions counts too. `claim_website_verified` is warn, so it
  is emailed. Past the claims lane's hourly cap, each place still gets one claim or co-sign message an hour, for at
  most 30 places an hour.
- Paid Google lookups take their caps first. Website claims: 10 new codes a day per network, 20 per shop, then the
  global daily budget, all before the lookup. Launch prepare and the claim call's contact lookup spend the global
  budget too, and the claim call takes its network and shop caps before the phone lookup. The `google_budget` alert
  names everything that stops.
- Website claims on hosting platforms. A customer subdomain of a multi-tenant host (`rosies.netlify.app`,
  `rosies.github.io`, ...) is its own registrable domain, so a redirect to another customer's site is refused; a bare
  platform host or public suffix is never a business's own site; Blogger's country domains, cloud storage endpoints
  (S3, Google Cloud Storage, Azure, DigitalOcean Spaces) and more path-hosted platforms are refused outright. A website
  on a multi-tenant host is flagged in the claim alerts for the human check. The suffix list stays out of the browser
  bundle. Suffixes one label deeper (App Engine regions, Azure Static Web Apps partitions, Elastic Beanstalk regions)
  count too; tunnels and dynamic DNS names are refused. The full Public Suffix List is a follow-up.
- Moderation. AtlasPad is caught inside longer words, in all caps and spelt across words with anything run on to it
  ("ATLASPADX", "theatlaspad", "ATLAS PADCOIN", "atlas_padinu"). Only a short list of real words that begin "pad" is
  allowed after "Atlas" ("Atlas Padel Club", "Atlas Paddington", also in camel case: "AtlasPadelClub").
- Tests use fictional places instead of real businesses.

## v0.6.2 — 2026-10-29
- AtlasPad's X account, https://x.com/AtlasPadx, is linked from the desktop rail ("Follow", above Help), the mobile
  menu ("Follow @AtlasPadx") and the Help panel ("News and updates"); every link opens in a new tab. index.html sets
  `twitter:site` to @AtlasPadx so shared cards credit the account. A Help test keeps the link.
- Claim explainer video sources (videos/atlaspad-claim-explainer: HyperFrames composition, SPEC, REVIEW) and the
  filming tools (film.mjs request mocks, claim-seed.ts, claims-mocks.mjs, the claims look) with the scene scripts in
  videos/footage-claims. The example shop is the fictional "Rosie's Café" on devnet. Renders, audio and footage stay
  out of git.
- brand/x: X profile picture and banner (sources and PNGs); marketing/launch-hour-posts.md: the launch-hour posts.

## v0.6.1 — 2026-10-27
- The owner moved the program upgrade authority to Squads B vault 9MsjBLAV… (2-of-3, 7-day time lock) and funded the
  guardian with 0.01 SOL. deploy/mainnet.json records it. The mainnet watchdog shows 9 passed and 1 warning: the
  governance handover to Squads A (go-mainnet --propose-governance, within 30 days).

## v0.6.0 — 2026-10-27 · AtlasPad is live on Solana mainnet
https://atlaspad.online, launched by the owner with go-mainnet --execute (E1-E10).
- Program 6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x (sha256 91b91048…, the CI solana-verify build); Config
  FbgtYWxS… (claim window 72 h); ALT 5vmadCCx… (frozen); crank funded with 0.1 SOL; D1 cornershop-mainnet
  (migrations 0001-0004).
- Worker `cornershop` on atlaspad.online and www (Google Trust Services certificate); the workers.dev address 301s to
  atlaspad.online. /api/health is ok across the board, and smoke passes 56/56 (one warning: phone checks are off).
- deploy/mainnet.json (public addresses only) and the mainnet D1 id in wrangler.jsonc are committed, which switches on
  the GitHub Actions mainnet watchdog.
- Governance handover to Squads A pending; the upgrade authority moved to Squads B in v0.6.1.

## v0.5.5 — 2026-10-27
The resumed launch created and froze the mainnet ALT (5vmadCCx…) and funded the crank (+0.1 SOL). E5 then created
D1 cornershop-mainnet but refused to write its id: the `__D1_MAINNET_ID__` placeholder also appeared in a
wrangler.jsonc comment (there since v0.3.0).
- wrangler.jsonc: the comment no longer contains the token. A script test keeps each D1 placeholder at most once in
  the file.

## v0.5.4 — 2026-10-27
The resumed launch initialized the mainnet Config (tx 2oq93gDM…), then E3 stopped: the ALT pre-send simulation failed
with "BlockhashNotFound". A load-balanced RPC node had not yet seen the blockhash another node handed out.
- scripts/lib/web3.mjs simulateAndSend: re-simulates up to 5 times, 1.5 s apart, on BlockhashNotFound.
- scripts/create-alt.mjs: rebuilds the create + extend transaction with a fresh blockhash and slot on BlockhashNotFound,
  as it already did for "not a recent slot". A mainnet simulation of E3 passes (nothing sent).

## v0.5.3 — 2026-10-27
The resumed launch deployed the program (6t4zk…, sha256 91b91048…), then E2 initialize_config stopped on an Alchemy
429 ("compute units per second capacity").
- scripts/lib/web3.mjs: script connections now retry a 429 with web3.js's backoff. The request was refused, not
  executed, so retrying a send is safe. scripts/lib/rpc.mjs reads retry up to 4 times.
- go-mainnet: once the program is deployed (a resumed launch), the deployer needs only what is left (Config, ALT,
  crank, margin) and the 0.59 SOL floor no longer applies.

## v0.5.2 — 2026-10-27
The first mainnet program upload stopped with "Data writes to account failed: Max retries exceeded": 14 of 36 chunks
landed, and 0.183 SOL is parked in the resumable upload buffer.
- go-mainnet: the upload retries up to 100 times (the CLI default is 5) with a 10,000 µlamports/CU priority fee
  (DEPLOY_CU_PRICE). The free Alchemy plan's per-second limit dropped part of the write burst.
- go-mainnet: the deployer balance check counts the SOL already parked in the deployer's own upload buffer, so a
  re-run that resumes the buffer is not refused as "below 0.59 SOL".

## v0.5.1 — 2026-10-27
- v0.5.0 is on devnet (18:16 UTC): smoke 58/58, e2e 55/55, accuracy audit 342/342, watchdog green. MAINNET-CHECKLIST
  §1 records the new evidence and a devnet soak shorter than the 48 h target.

## v0.5.0 — 2026-10-27
Pre-mainnet fixes from a full top-to-bottom scan. Seven parallel checkers covered the live site on desktop and
mobile, the mainnet build and config, the money paths, API security, every automated suite, and copy, legal and
accessibility. Every finding was re-checked by a skeptic: 28 confirmed, 17 refuted. The fixes were made in four
worktree streams, each reviewed adversarially before merging.
- **No "DEMO" on the real site:** the phone menu showed "DEMO · simulated prices" ("No real transaction is ever sent")
  on real-money builds. It now uses the mode chip: DEVNET on devnet, nothing on mainnet. The demo explainer never
  renders in real mode.
- **Claim copy matches mainnet** (phone checks off): the shop steps, the coin's About tab, the launch dialog and Help
  now say owners verify with a code on the shop's own website. Shops without a website are told honestly that it isn't
  available yet and that their fees stay in the vault.
- **Business opt-out** from Help or the phone menu now leads to finding the shop first (it used to fail with "Say which
  coin or shop this is about"). "Watch" no longer promises a notification.
- **D1 within Workers Free** (100k rows written / 5M read a day for the whole account):
  - unchanged curve, pool, vault and 24 h figures are no longer rewritten, and the 24 h figures are computed once
    (materialized CTE);
  - a partial index (migration 0004) ends the per-minute full scan of trades;
  - the devnet cron runs every 5 minutes (mainnet stays at 1 minute), with freshness windows scaled to the cron period;
  - the vault sweep keeps 8 slots so busy coins cannot starve idle ones.
- **Storage abuse:** unlaunched uploads are deleted after 6 h (was 30 days); a global 400 uploads/day budget; an
  identical re-upload refreshes its timestamp.
- **Security:**
  - per-IP limits key IPv6 on its /64;
  - a global 3,000/day budget on paid Google lookups;
  - mainnet /api/rpc only relays sends and simulations that name the AtlasPad, pump or pump-amm programs (RL_RPC 200,
    RL_SEND 15);
  - HSTS on every page and asset;
  - share cards no longer invent a $TICKER for any short /c/ id;
  - the website verify-tag scan is quote-aware and ends comments where browsers do.
- **Ops:**
  - smoke accepts mainnet's 404 not_found for /api/dev/airdrop, so go-mainnet no longer reports a false failure after
    a good deploy;
  - the post-launch follow-ups now say to push deploy/mainnet.json (this switches on the GitHub watchdog) and to claim
    with the website code;
  - the crank is funded with 0.1 SOL, and the watchdog warns below 0.02 SOL (critical below 0.005). It also warns when
    the guardian cannot pay fees.
- **Guardian page:** new scripts/guardian.mjs, a local page where the Phantom guardian cancels a wrong claim or pauses
  or unpauses launches. Steps are in RUNBOOK §8.
- **Small fixes:** flat coins no longer draw a fake crash or spike on the price chart; dust no longer lights the My coins
  badge; the buy "Min" rounds down; a stale tab reloads once after a deploy (not when offline).
- **Accuracy audit:** tolerances follow the cluster's cron period (devnet 5 min).

## v0.4.9 — 2026-10-27
The owner's manual Phantom test on devnet passed (MAINNET-CHECKLIST §1 marked done):
- **Launch:** $DREAMERY with a 0.1 SOL first buy. Phantom showed the "This domain is new" warning, which is expected
  for any new domain, atlaspad.online included.
- **Trades:** buys and sells from two wallets, all in the Live feed. Fees waiting rose from 0.000296 to 0.000444 to
  0.001185 SOL.
- **Claim and withdraw:** claimed $YOGAHOME with the devnet on-screen code (The Dreamery's listing has no phone, and
  its website is not ours). The cron finalized the claim 1 minute later. Withdraw paid exactly the 0.001671246 SOL
  waiting.
- **First-withdraw cost:** the owner also paid 0.00065024 SOL once, to top up pump.fun's creator-vault account to rent
  exemption (it held 240,640 lamports). The withdraw toast shows this inside "network fee 0.00066 SOL".
- **Operator name:** the Terms and Privacy pages name the operator "AtlasPad".

## v0.4.8 — 2026-10-26
The mainnet Squads multisigs exist. The owner created them with `create-squads.mjs` (record:
`deploy/mainnet-squads.json`).
- **Squads A** (governance) `7R8zT9766QL4PtExBSa4bC8AaNnE4ez5Ls9w81CPV49A`: 2-of-3, time lock 0, autonomous, vault
  `CvtvjVDJ7fGsHyfL1sRLLzd5AiZ2WFZYaX6Kb3ay3ryd`.
- **Squads B** (upgrade authority) `EpdZ1GKCCABayXirQLVQhytevicLqcsaGkU9WnazNrwf`: 2-of-3, time lock 7 days,
  autonomous, vault `9MsjBLAV5DHkPau5RjKaS2r6D2f2hf4sf5bmdxNfjkkZ`.
- Two independent read-only checks (the official Squads SDK, and a hand decode of the raw accounts against the Squads v4
  source) confirmed the members, masks, thresholds, time locks, PDAs and creation transactions: 52 checks, 0 problems.
- go-mainnet: the deployer floor is 0.59 SOL (was 0.6). The owner sends 0.6 SOL and create-squads pays about 0.004 SOL
  of rent from it; the computed need for the deploy is about 0.45 SOL.
- create-squads: new `--deploy-dir` option. The CLI usage test runs in an empty one, so the real records (a finished
  pair needs no `--payer`) never change what it tests.
- MAINNET-CHECKLIST: deployer funds, Squads A and B, and six distinct keys marked verified.

## v0.4.7 — 2026-10-26
- Google: the browser Maps key `cornershop-web` now allows `https://atlaspad.online/*` (tested: Places answers 200 for
  atlaspad.online and devnet, 403 for any other site). The £10 monthly budget alert (50%, 90%, 100%) was already on;
  the free trial credit lasts until 6 January 2027. MAINNET-CHECKLIST §3 marked verified.

## v0.4.6 — 2026-10-26
- MAINNET-CHECKLIST §7 wording.

## v0.4.5 — 2026-10-26
- go-mainnet: the deployer top-up hint no longer reads "0.6 SOL SOL".

## v0.4.4 — 2026-10-26
Devnet sign-off evidence refreshed after the v0.4.3 deploy (e2e 55/55, accuracy audit 282/282).
- **e2e**: the exact-fee checks now compare against every trade of the test coin on chain, not only the test's own.
  A devnet bot bought and sold the 17:02 test coin during the claim window; its 8,889 lamports of creator fees were
  real vault money that AtlasPad counted correctly, but the old check expected only the test's trades and failed. The
  payout check counts trades up to the withdraw's slot, and "waiting" after the withdraw is the fees since then.
- **Watchdog**: unacknowledged `info` alerts (claims, reports, opt-outs, already emailed) are listed but are no longer
  warnings, so a healthy run exits 0. Warning and critical alerts are unchanged.
- MAINNET-CHECKLIST: today's verified items marked (alerts, keys, verifiable build, SIMD-0500, DNS, phone claims off),
  Workers Free noted, and the devnet 48 hours now end on
  2026-10-28 at 17:01 UTC. Every box stays unticked for you.

## v0.4.3 — 2026-10-26
Mainnet no longer needs a Discord account: owner alerts can go by free email.
- **Alert email** (`worker/email.ts`): Cloudflare Email Routing's `send_email` binding `ALERT_EMAIL` (env.devnet and
  env.mainnet, unrestricted) emails each alert from "AtlasPad alerts <alerts@atlaspad.online>" to the
  `ALERT_EMAIL_TO` secret, an address verified in Email Routing. Plain-text RFC 5322 message (UTF-8 subjects, base64
  body), header-injection safe, best effort (never fails a request), and no address is ever logged or committed.
- `worker/notify.ts` sends every alert to each channel that is set (webhook and/or email) with a short subject such as
  `[AtlasPad mainnet] WARN owner_claim: …`. `alert()` and the owner alerts keep their de-duplication and hourly limits.
- go-mainnet requires `ALERT_WEBHOOK_URL` **or** `ALERT_EMAIL_TO` (with the `ALERT_EMAIL` binding checked in
  wrangler.jsonc); the secret scripts push `ALERT_EMAIL_TO` from `.env.server` on devnet and mainnet.
- Watchdog: a critical result fails the GitHub Actions run, and GitHub's failed-run email is its free email channel;
  `ALERT_WEBHOOK_URL` is optional there. The daily D1 backup's `CLOUDFLARE_API_TOKEN` is optional too (the workflow
  skips without it; D1 Time Travel already restores any point of the last 7 days on the free plan).
- MAINNET-CHECKLIST, OPS-AUTOMATION, RUNBOOK and the Privacy page updated; tests guard that no personal email address
  is ever committed.
- **`scripts/create-squads.mjs`**: one command creates both Squads v4 multisigs for mainnet (A governance 2-of-3, time
  lock 0; B upgrade authority 2-of-3, 7 days; autonomous), paid by the deployer, then checks them with go-mainnet's own
  rules and prints the `--squads-a/--squads-b` flags. Mainnet needs an interactive terminal and a typed phrase. Proven
  on devnet (rent ≈ 0.004 SOL for both; Squads' creation fee is 0).
- Every script: an on/off flag takes no value, so `--execute=false` (or `=0`) is refused instead of executing.

## v0.4.2 — 2026-10-26
- The "Verifiable build (shop-vault)" GitHub workflow passes Docker an absolute program path (a relative one was read
  as a volume name and the build refused to start).

## v0.4.1 — 2026-10-26
- Mainnet starts on Cloudflare **Workers Free**: `POLICY_REFERENCE` is `"0"` on `env.mainnet` (the reference co-sign
  check is off; the strict policy gate stays on), so go-mainnet asks you to confirm the Free-plan limits instead of
  Workers Paid. Set it back to `"1"` when moving to Workers Paid.

## v0.4.0 — 2026-10-26
Mainnet readiness: everything on the code side of the mainnet checklist, for the cheapest safe launch.
- **Sanctions**: visitors from blocked countries and regions (default KP, IR, SY, CU, RU, BY and UA-43/40/14/09;
  `BLOCKED_COUNTRIES` / `BLOCKED_REGIONS`) get a 451 page and every money route refuses them; launches for businesses
  located there are refused; launcher, payout and fee-payer wallets are screened against the OFAC SDN list
  (`scripts/update-sanctions.mjs`).
- **Terms and Privacy** rewritten for real money (UK GDPR, claims and disputes, honest description of who can move or
  freeze fees), a one-time risk warning + 18+ + Terms acceptance before the first transaction, hello@atlaspad.online
  published, a not-affiliated notice in every coin's on-chain description, "atlaspad" refused in coin names, and
  check-bundle fails a mainnet build that still ships prototype wording.
- **atlaspad.online**: mainnet `PUBLIC_ORIGIN` and custom domains, workers.dev and www redirect to it, AtlasPad share
  card and meta tags, `atlaspad-verify` website markers (old `cornershop-verify` still accepted), ops docs renamed,
  go-mainnet phrase `DEPLOY ATLASPAD TO MAINNET`.
- **Claims**: Discord/Slack owner alerts for claims, re-claims, disputes, reports, opt-outs and review requests; phone
  checks optional (mainnet launches without Twilio; Turnstile is only needed with it); manual review hidden on mainnet;
  opted-out or hidden coins can still be claimed by their owner; opted-out places can't get a coin; report personal
  data scrubbed after 180 days.
- **Withdraw**: a withdraw that would cost more in network fees than it pays out is refused with an explanation; the
  toast shows the payout and the fee (never "Withdrew 0 SOL"); right-sized compute and priority fees for vault actions;
  long countdowns read "2 d 23 h"; mainnet-scale number formatting covered by tests; realistic launch cost in Help.
- **Ops**: the watchdog posts criticals to the webhook and knows the planned Squads handover; free GitHub Actions run it
  every 30 minutes plus a daily D1 backup; `deploy-mainnet-hotfix.mjs` ships fixes without dropping vars; go-mainnet
  rejects stale devnet evidence, can waive the graduation test, accepts a CI-built verifiable binary and follows the
  chosen Workers plan; CI also runs the 112 Rust program tests; re-tested against pump.fun's 2026-10-19 mainnet
  upgrade (no layout change; mainnet trade fixtures added).
- MAINNET-CHECKLIST.md rewritten for AtlasPad and the free-tier launch. Devnet redeployed; e2e (53 checks) and accuracy
  audit (262 checks) green on this build.

## v0.3.1 — 2026-10-26
- Fresh clones build: `npm run vault-client` installs and builds the local `shop-vault` client that the app
  imports (its `dist/` is not committed). It runs before `npm ci`/`npm install`, which copy the client in;
  CI and the README setup both do it in that order.
- CI actions moved to checkout@v5 / setup-node@v5 (Node 20 actions are deprecated).
- Promo video sources (v1 and the v2 real-footage cut), the filming tools and scenes are in `videos/`.

## v0.3.0 — 2026-10-25
- Product renamed **AtlasPad** (wordmark ATLASPAD): tab titles, map watermark, rail, share card and X posts,
  help, terms and privacy pages, promo title/end cards. Internal ids unchanged.
- Wordmark font subset rebuilt for ATLASPAD; fonts are never inlined into the CSS (keeps the initial CSS budget).
- Repository created; CI runs typecheck and every test on each push.

## v0.2.0 — 2026-10-09
- Real mode on Solana **devnet**: pump.fun launches with the shop vault as creator, trades, live feed, top shops,
  My coins, owner claims (phone code / website code / manual review) with a 60 s public window, withdrawals.
- `shop-vault` Pinocchio program deployed on devnet; end-to-end test passed (44/44).
- QA: end-to-end, accuracy against chain state, speed budgets, security (co-sign policy, RPC proxy, uploads); two fix rounds.
- Scripted mainnet flip (`npm run go-mainnet`, dry run) and checklist.

## v0.1.0 — 2026-10-08
- Phase 1 clickable prototype (demo mode): Google-Maps-style map, every control working, simulated chain.
