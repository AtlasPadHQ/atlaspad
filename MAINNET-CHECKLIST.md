# AtlasPad mainnet checklist

> Completed 2026-10-27 for the v0.6.0 mainnet launch. The committed copy is kept unticked as the template for future
> launches (a test keeps it that way); the dated notes in bold record what was checked for v0.6.0.

This is the list of things that must be true before AtlasPad goes live on Solana mainnet. Tick a box by changing
`- [ ]` to `- [x]`. `scripts/go-mainnet.mjs` reads this file and **refuses to run while any box is unticked**.

It is written for the cheapest safe launch: free tiers wherever they hold, and paid items only where there is no free
alternative. Boxes marked **(verified …)** were checked by the integrator on the date shown: read them and tick them.
go-mainnet re-checks the devnet evidence itself (the reports must be newer than the last devnet deploy and at most 7
days old).

How to use it:

1. Work down the list. Boxes marked **(verified …)** only need reading and ticking; the rest are things only you can do (accounts, money, decisions, keys).
2. Run the read-only check as often as you like. It sends nothing and changes nothing, and it lists what is still
   missing:
   `node scripts/go-mainnet.mjs --dry-run --deployer <your wallet keypair file> --guardian <guardian address> --squads-a <multisig A> --squads-b <multisig B>`
3. When the dry run is all ✓ and every box here is ticked, run the same command with `--execute` instead of
   `--dry-run`, in your own terminal. It asks you to confirm a few facts and to type `DEPLOY ATLASPAD TO MAINNET`.

Background reading: `RUNBOOK.md` (how to operate it), `docs/OPS-AUTOMATION.md` (free monitoring and backups on GitHub
Actions), `programs/shop-vault/SPEC.md` §11 (the on-chain order of steps).

---

## 1. Devnet sign-off (everything works on test money first)

- [ ] **(verified 2026-10-26)** The automated end-to-end test passed against `cornershop-devnet` on the current build:
      `npm run e2e:devnet -- --execute` (2026-10-27 18:17 UTC on v0.5.0, 55 checks: launch, duplicate refused, trades, fees exact
      to the lamport for every trader including devnet bots, claim, finalize, withdraw). Re-run it if devnet is redeployed before launch.
- [ ] The **graduation test** passed on devnet, or is waived with a reason (`--waive-graduation "<reason>"`): pump.fun's
      devnet migration bot never created the PumpSwap pool (pool `4MhKxT85…` did not exist at v0.6.0). The
      graduated-coin fee path is covered by tests against real mainnet PumpSwap trades (`src/chain/mainnet.test.ts`,
      `worker/pumpMainnet.test.ts`).
- [ ] **(verified 2026-10-26)** The accuracy audit is green: `node scripts/accuracy-audit.mjs https://cornershop-devnet.tiejiucai.workers.dev --json`
      (2026-10-27 on v0.5.0, 342 checks; set `RPC_URL` to a keyed endpoint, the public one rate-limits).
- [ ] **(done 2026-10-27 in Phantom: launched $DREAMERY with a 0.1 SOL first buy, buy and sell from a second wallet,
      claimed $YOGAHOME with the on-screen code, the cron finalized it, withdrew exactly the 0.001671246 SOL waiting)**
      You did the manual test with a real wallet (RUNBOOK "Manual test on devnet") in **Phantom**, with the devnet
      build: launch a real café with a 0.1 SOL first buy, buy and sell from a second wallet, claim, finalize, withdraw.
      Solflare too if you can.
- [ ] **(verified 2026-10-26)** `?mode=demo` on devnet still behaves like the old demo, with no `/api/rpc`, `/api/coins` or `/api/market` requests.
- [ ] **(verified 2026-10-26)** The mainnet bundle check is green: `npm run build:mainnet && node scripts/check-bundle.mjs dist-mainnet --cluster mainnet --build-worker`
      (2026-10-26, 16 checks: no test wallet, no `/api/dev/`, no secrets, Terms and Privacy written for real money,
      size budgets met).
- [ ] The devnet Worker ran for **48 hours** with no critical alert after its last deploy (`node scripts/watchdog.mjs --cluster devnet`
      exits 0 and `/api/health` stays `ok`). v0.6.0: v0.5.0 went live on devnet on 2026-10-27 at 18:16 UTC; the soak
      was shorter than the 48 h target, with no critical alert.

## 2. Money (the only thing you must buy)

- [ ] **(verified 2026-10-26: 0.6 SOL received, 0.596 SOL left after the Squads rent)** Your deployer wallet received
      **0.6 SOL** and still holds **at least 0.59 SOL** after creating the Squads multisigs. About **0.29 SOL stays locked**: 0.184 SOL program
      rent, small rents for the settings account and the lookup table, and 0.1 SOL for the fee crank. The temporary
      upload buffer (about 0.18 SOL) comes back at the end of the deploy.
- [ ] The deployer is a normal wallet **keypair file** that you control and can delete afterwards. Its powers move to
      the Squads multisigs right after launch. You will top up the fee crank (`.keys/mainnet-crank.json`) when the
      watchdog says it is low (it warns below 0.02 SOL and fails below 0.005 SOL).

## 3. Accounts and services (free tiers)

- [ ] **(you chose Free, 2026-10-26; `POLICY_REFERENCE` is `"0"`)** **Cloudflare plan decided.** Either Workers **Free**, with `POLICY_REFERENCE` set to `"0"` in `wrangler.jsonc`
      `env.mainnet.vars` (fine for a quiet soft launch: 100,000 requests a day; the strict co-sign policy stays on), or
      **Workers Paid** ($5/month) with `POLICY_REFERENCE` `"1"`. Move to Paid before traffic grows.
- [ ] **Alchemy**: Solana mainnet is enabled on your Alchemy app, and usage alerts are on. The free tier is fine at
      launch; a separate app (`ALCHEMY_API_KEY_MAINNET`) is optional.
- [ ] **(verified 2026-10-26)** **Owner alerts reach you.** Free and no Discord account needed: `ALERT_EMAIL_TO=<the address you verified>`
      in `.env.server`. `atlaspad.online` has Email Routing on and that address is a **verified destination address**
      (dashboard → atlaspad.online → Email → Email Routing → Destination addresses), so the Worker emails every alert
      from `alerts@atlaspad.online` through Cloudflare Email Routing to your verified destination inbox. **Or** a
      Discord channel webhook as `ALERT_WEBHOOK_URL` (both work together). One of the two is required: every claim, dispute, report and opt-out
      is sent there, and website-code claims need your check before they unlock. The address only ever lives in
      `.env.server` and the Worker secret, never in a committed file.
- [ ] **(verified 2026-10-26: referrer added and tested, £10 monthly budget alert on, trial ends 6 January 2027)** The **Google browser key** (`cornershop-web`) allows the referrer `https://atlaspad.online/*`, the **server key**
      (`GOOGLE_SERVER_KEY`) is in `.env.server`, and a budget alert is set. The free-trial credit ends around early
      January 2027: move the project to a paid billing account with daily quotas before then, or the map stops.
- [ ] **(verified 2026-10-26)** **Phone claims are off at launch** (no `TWILIO_*` in `.env.server`): owners verify with a code on their website.
      When you add Twilio later, add all three values plus a Cloudflare Turnstile widget for `atlaspad.online`
      (`TURNSTILE_SECRET_KEY`, `env.mainnet.vars.TURNSTILE_SITE_KEY`), and name the Verify service **AtlasPad**.
- [ ] The free GitHub Actions monitoring is set up for `AtlasPadHQ/atlaspad` (docs/OPS-AUTOMATION.md). The watchdog
      runs every 30 minutes with no secret at all, and a **critical finding fails the run, so GitHub emails you** (your
      GitHub notification settings send failed-workflow emails; GitHub emails whoever last changed the watchdog's
      schedule). Ideally add `ALCHEMY_API_KEY`. Optional: `ALERT_WEBHOOK_URL` (criticals also go to Discord), and
      `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` for the watchdog's D1 reads. The daily off-Cloudflare database
      backup also needs the `D1_BACKUP_PASSPHRASE` secret and the repository variable `D1_BACKUP_ENABLED=true` (backups
      are always encrypted: Actions artifacts on a public repository can be downloaded by anyone). D1 Time Travel
      already gives point-in-time restore on the free plan (the last 7 days).
- [ ] Optional: a Jupiter API key (`JUPITER_API_KEY`). `PRIVY_APP_ID` has no effect yet: email login stays hidden until
      a real Privy integration exists.

## 4. Keys and governance (who can change what)

- [ ] **(verified 2026-10-26)** `.keys/mainnet-attestor.json`, `.keys/mainnet-crank.json` and `.keys/mainnet-hmac.key` exist
      (`node scripts/go-mainnet.mjs --create-keys`). They are new keys, never used on devnet.
- [ ] After go-live you will put `.keys/mainnet-attestor.json` in an **encrypted offline backup** and delete it from
      the machine that ran the launch. The Worker secret is the only live copy it needs.
- [ ] The **guardian** is a wallet only you control, on its own device (a hardware wallet is best). You know how to
      sign with it and can be reached within days: it must veto any proposal you did not plan within **7 days**. With
      Phantom, you cancel a wrong claim or pause launches through `node scripts/guardian.mjs`
      (RUNBOOK §8 "Guardian: cancel a wrong claim / pause launches"; rehearse it once on devnet), and the account keeps
      about 0.01 SOL for fees.
- [ ] **(verified 2026-10-26: `7R8zT976…`, 2-of-3, time lock 0, autonomous)** **Squads multisig A** (governance) exists on mainnet: **2-of-3**, each member a wallet on a **different device**
      (hardware wallets are best), **time lock 48 hours or less** (0 to 12 hours is best), and no config authority.
- [ ] **(verified 2026-10-26: `EpdZ1GKC…`, 2-of-3, time lock 7 days, autonomous)** **Squads multisig B** (program upgrade authority) exists and is a **different** multisig from A. It may have a
      longer time lock (for example 7 days).
- [ ] **(verified 2026-10-26)** Attestor, guardian, governance (A), upgrade authority (B), deployer and crank are **six different keys**. The
      dry run checks this.
- [ ] You agree the rule: **every planned admin change is registered first** with `scripts/admin-expect.mjs`, so the
      monitor can tell planned changes from attacks.

## 5. Program build

- [ ] **(verified 2026-10-26)** The program binary is the reproducible build: run the **Verifiable build (shop-vault)** workflow on GitHub
      Actions (free, no Docker needed), download its artifact, and pass `--verified-artifact <dir>` to go-mainnet. (A
      local Docker + `solana-verify` build with `--verify` works too.)
- [ ] **(verified 2026-10-26: not active)** You checked whether SIMD-0500 is active on mainnet (the dry run prints it). If it is, the program was rebuilt for
      SBPF v3 and re-tested.

## 6. Domain

- [ ] **(verified 2026-10-26)** The **final domain is decided**: `https://atlaspad.online` (`PUBLIC_ORIGIN` in `env.mainnet`, with custom-domain
      routes for the apex and `www`). Coin metadata links are written on-chain forever. `cornershop.tiejiucai.workers.dev`
      keeps working and redirects to the domain (never disable workers.dev).
- [ ] **(verified 2026-10-26)** In the Cloudflare dashboard, `atlaspad.online` has no parking `A`, `AAAA` or `CNAME` records for the apex or `www`,
      auto-renew is on at Porkbun (prepaying a few years is best), and the registrar lock is on. If the domain ever
      lapsed, whoever bought it would control every coin's image and metadata link.

## 7. Legal and disclosure

- [ ] UK legal and data-protection obligations reviewed (the operator's responsibility; this checklist is not legal advice).
- [ ] **(verified 2026-10-26)** Help and the Terms explain the **pump.fun risks**: pump.fun's admins can redirect future creator fees of any coin
      and can upgrade their programs. AtlasPad cannot prevent that.
- [ ] **(verified 2026-10-26)** Every unclaimed shop shows **"Unclaimed · not affiliated with this business"**, every coin's description carries
      the not-affiliated notice, and the Terms and Privacy pages are written for real money (check-bundle enforces it).
      Users accept the risk warning and Terms before their first transaction.
- [ ] **(verified 2026-10-26)** The **sanctions block** is live: blocked countries and regions get a 451 page and every money route refuses them;
      launches for businesses there are refused; launcher and payout wallets are screened against the OFAC list
      (`node scripts/update-sanctions.mjs --check` is green: 4 Solana addresses, list of 2026-10-21).
- [ ] The **takedown route** works: you tested `scripts/moderate.mjs --optout` on devnet, and you read the alert emails
      (or Discord) for reports and opt-outs at least daily.

## 8. Monitoring and people

- [ ] The watchdog runs on a machine that is **not** the Worker: the free GitHub Actions schedule
      (`.github/workflows/watchdog.yml`, secrets from §3), or another machine you control (`node scripts/watchdog.mjs --cluster mainnet --loop 900`).
      Critical findings fail the run and GitHub emails you (and post to Discord when `ALERT_WEBHOOK_URL` is set).
      Right after go-live, commit and push `deploy/mainnet.json` and `wrangler.jsonc`
      (`git add deploy/mainnet.json wrangler.jsonc && git commit -m "mainnet live" && git push`), then run the
      **Watchdog (mainnet)** workflow once and check it no longer says "nothing to watch": until that file is on
      GitHub, the GitHub watchdog does nothing.
- [ ] You are **on call** for the first two weeks, with the guardian wallet within reach.
- [ ] You read RUNBOOK sections "Alerts", "Compromised attestor" and "pump.fun took over a coin" once, end to end.
