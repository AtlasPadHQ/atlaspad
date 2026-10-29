# AtlasPad

> your cafe. your barber. your kebab shop.
> launch a coin for any business on earth. 100% of creator fees are held for the shop's verified owner.
> paste a google maps link. launch. done.

AtlasPad (https://atlaspad.online) is a memecoin launchpad on a map-first UI, for **Solana** via **pump.fun**. You
pick any business on the map, or paste its Google Maps link, and launch a community coin for it. There is one coin per
Google Place ID, and the first launch wins. The coin's pump.fun creator is a per-shop vault run by our `shop-vault`
program, so 100% of its creator fees are held there until the business's owner proves ownership and claims them (on
mainnet: a code on the shop's own website), after a public 72-hour window.

Internal ids keep the earlier working name `cornershop` on purpose (Worker names, D1/KV names, storage keys, the
program crate): renaming them would break deployed URLs and on-chain metadata.

## Status

- **Live on Solana mainnet** since 2026-10-27 (v0.6.0, see [`CHANGELOG.md`](CHANGELOG.md)). Program id
  `6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x`; every public address is in
  [`deploy/mainnet.json`](deploy/mainnet.json).
- `shop-vault` has **not** had an independent external audit. [`SECURITY.md`](SECURITY.md) covers its audit status,
  who can do what on chain, and how to report a vulnerability.
- A devnet copy with test SOL runs at https://cornershop-devnet.tiejiucai.workers.dev. Any build shows the simulated
  demo with `?mode=demo`.

## Verify the program build

The mainnet binary is the `solana-verify build` of `programs/shop-vault` (the "Verifiable build (shop-vault)" workflow,
`.github/workflows/verifiable-build.yml`, runs the same build). You need Docker and solana-verify; the Docker image
follows `[workspace.metadata.cli] solana` in `programs/shop-vault/Cargo.toml`.

```bash
cargo install solana-verify --version 0.5.2 --locked
solana-verify build "$PWD/programs/shop-vault" --library-name shop_vault   # absolute path: Docker reads a relative one as a volume name
sha256sum programs/shop-vault/target/deploy/shop_vault.so                  # = programDataSha256 in deploy/mainnet.json (macOS: shasum -a 256)
solana-verify get-executable-hash programs/shop-vault/target/deploy/shop_vault.so
solana-verify get-program-hash -u https://api.mainnet-beta.solana.com 6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x
```

The last two hashes must match: the first is your build, the second is the program deployed on mainnet.

## Repository layout

```
src/                  the web app (Vite + React + TypeScript): map, search, panels, launch, claim, trade, wallets
worker/               Cloudflare Worker: /api/*, share pages, the indexer cron, co-signing policy, alerts
programs/shop-vault/  the on-chain vault program (Rust, Pinocchio), its TypeScript client, LiteSVM tests, SPEC.md
scripts/              operator scripts: devnet deploy, go-mainnet, watchdog, guardian page, moderation, audits
                      (dry runs unless given --execute; scripts/README.md)
migrations/           D1 (SQLite) schema migrations
docs/                 free GitHub Actions monitoring, backups and the verified build (OPS-AUTOMATION.md)
deploy/               public on-chain addresses per cluster
public/               favicon, share card, Terms, Privacy
brand/                brand artwork (not licensed; see TRADEMARKS.md)
```

| Doc | What's in it |
|---|---|
| [`DESIGN.md`](DESIGN.md) | The definitive UI spec. §18 lists every control and what it does |
| [`CONTRACTS.md`](CONTRACTS.md) | Module ownership, exports, types, store API, conventions, integration decisions |
| [`INTEGRATION.md`](INTEGRATION.md) | Real mode: environments, D1 schema, Worker API, chain layer, budgets, accuracy rules, scripts |
| [`programs/shop-vault/SPEC.md`](programs/shop-vault/SPEC.md) | The on-chain vault program (accounts, instructions, co-sign rules, threat model, go-mainnet) |
| [`RUNBOOK.md`](RUNBOOK.md) · [`MAINNET-CHECKLIST.md`](MAINNET-CHECKLIST.md) | Operating devnet and mainnet, incidents, and the go-live checklist |
| [`docs/OPS-AUTOMATION.md`](docs/OPS-AUTOMATION.md) | Watchdog and backups on GitHub Actions, hotfixes, the verified build, Squads setup |
| [`CHANGELOG.md`](CHANGELOG.md) | Every release |

Design notes cited in code comments and docs as `research/…` or `BRIEF.md` are internal and not published.

## Local development

Node 22.18 or newer.

```bash
npm run vault-client            # first: builds programs/shop-vault/client, which npm ci copies in
npm ci
cp .env.example .env.local      # optional: VITE_GOOGLE_MAPS_KEY; empty runs the OpenStreetMap demo map
npm run dev                     # http://localhost:5173, demo mode: every chain action is simulated
npm run typecheck && npm test && npm run test:scripts
```

`.env.example` lists every variable by name, with what it is for; real values never go in a committed file. Real mode
on devnet needs your own keys and a local Worker: [`RUNBOOK.md`](RUNBOOK.md) §2 and §4.

The program's tests need the Agave CLI 4.1.2 and run against the committed pump.fun fixtures (as CI does):

```bash
cd programs/shop-vault
cargo build-sbf --features devnet --sbf-out-dir target/deploy-devnet
cargo build-sbf --sbf-out-dir target/deploy
cargo test --locked
```

## Licence

- The app, Worker, scripts and docs: **GNU AGPL-3.0-or-later** ([`LICENSE`](LICENSE)). If you run a modified copy as a
  network service, you must offer its users the source.
- `programs/shop-vault/` (the program, its Rust and TypeScript clients and scripts): **Apache-2.0**
  ([`programs/shop-vault/LICENSE`](programs/shop-vault/LICENSE)).
- The `*.woff2` font files: **SIL Open Font License 1.1** ([`LICENSES/`](LICENSES/)); the project licences do not
  apply to them.
- The AtlasPad name, wordmark and logos are **not licensed**: see [`TRADEMARKS.md`](TRADEMARKS.md).

<!-- end of the licence section (it starts at "## Licence") -->

## Security

Please report vulnerabilities privately, never in a public issue: see [`SECURITY.md`](SECURITY.md).

## Contributing

Issues and pull requests are welcome. Keep changes small and focused, add or update tests for any behaviour you change,
and run `npm run typecheck`, `npm test` and `npm run test:scripts` (plus `cargo test` for program changes) before
opening a pull request. Contributions are accepted under the licence of the files they change.

## Disclaimer

Coins launched on AtlasPad are community coins. A coin is not affiliated with, endorsed by or connected to the business
it is named after unless that business's owner has claimed it, and even a claim only shows that someone passed
AtlasPad's verification. Memecoins are high risk and most lose all their value. Nothing in this repository or on the
site is financial or investment advice. The software is provided as is, without warranty (see the licences).

---

# Developer reference

## Stack

- Vite 8 + React 18 + TypeScript 5.9 (strict), zustand 5, plain CSS with design tokens (no UI kit).
- Google Maps JavaScript API, loaded through the official dynamic bootstrap (`v=weekly`):
  - the raster default basemap (no `mapId`);
  - coin pins as HTML inside one `OverlayView`;
  - POI clicks via `event.placeId`;
  - search with Places API (New) (`AutocompleteSuggestion` with session tokens, `searchByText`,
    `searchNearby`);
  - Google's place content rendered only by the Places UI Kit (`<gmp-place-details>` and
    `<gmp-place-details-compact>`).
- Fallback map: MapLibre GL + OpenFreeMap (liberty style) + Photon search, with clickable OSM POIs.
- Wallets: Wallet Standard `getWallets()` (Phantom, Solflare and Backpack pinned; legacy injected
  providers as a fallback). Real mode signs with `solana:signTransaction`; demo mode only ever calls
  `standard:connect`, `standard:disconnect` and `standard:events`.
- Chain: `@solana/web3.js`, the pump.fun SDKs and the local `shop-vault` client, loaded only in real mode.
- Hosting: Cloudflare Workers with static assets and D1. The Worker (`worker/`) serves `/api/*` and the share
  pages.

## Modes

The app has two modes from one codebase:

- **Demo mode** (the clickable Phase-1 prototype): every button works and everything that would touch the chain is
  **simulated**. It never asks a wallet to sign anything. Any real build with `?mode=demo`, and the demo-only
  `npm run build`.
- **Real mode**: real pump.fun coins on Solana, the shop-vault program, real trades, claims and withdrawals. On
  mainnet at https://atlaspad.online, and on devnet at https://cornershop-devnet.tiejiucai.workers.dev (test SOL; a
  built-in "Devnet Test Wallet" gets airdropped test SOL).

## Run locally

```bash
npm run vault-client            # first: builds programs/shop-vault/client, which npm install copies in
npm install
cp .env.example .env.local      # put the browser key in VITE_GOOGLE_MAPS_KEY
npm run dev                     # http://localhost:5173 (strict port: the browser key only allows :5173 / :4173)
npm run typecheck               # tsc -b (app + vite config + worker)
npm test                        # vitest (app, chain layer, Worker)
npm run test:scripts            # node --test scripts/test/*.test.mjs (pure logic, no network)
npm run build                   # typecheck + vite build → dist/ (demo-only build)
npm run preview                 # http://localhost:4173
```

`npm run dev` has no `/api`: Vite proxies `/api/*` to `wrangler dev` on `:8787`. To get the link
resolver and the listing-phone lookup locally, run the Worker next to Vite:

```bash
cp .env.server .dev.vars        # GOOGLE_SERVER_KEY=…  (gitignored)
npm run build && npx wrangler@4 dev    # serves dist/ + the API on http://localhost:8787
```

Without the Worker, full `google.com/maps/place/…` links still resolve in the browser. Short
`maps.app.goo.gl` links then show "Couldn't read that link". Real mode on devnet locally: RUNBOOK §4
(`npm run worker:devnet` and `npm run dev:devnet`).

Dev-only QA states: `/?state=hero`, `/?state=unlaunched`, `/?state=launch`,
`/?state=live`, `/?search=1`.

## Env and secrets

Every name is in `.env.example`; the full inventory is RUNBOOK §3. The two Google keys:

| Name | Where | What |
|---|---|---|
| `VITE_GOOGLE_MAPS_KEY` | `.env.local` (gitignored) | **Browser** key: Maps JS + Places API (New) + Places UI Kit, referrer-restricted to the site's origins and `http://localhost:5173/*` / `http://localhost:4173/*`. It is compiled into the bundle, which is expected. Empty → the app runs on the OpenStreetMap demo map |
| `GOOGLE_SERVER_KEY` | Worker secret (`.env.server` locally, `.dev.vars` for `wrangler dev`) | **Server** key: Places API (New) + Maps Grounding Lite (`resolveMapsUrls`). It never reaches the client (to check a build: grep `dist/` for the value; it must not be there) |

Secrets reach Cloudflare only through the scripts, which pipe them into `wrangler secret` through stdin
(`node scripts/lib/secretPut.mjs NAME --env <env> --from env:NAME --execute`; RUNBOOK §3).

## Deploy

**Devnet** (Worker `cornershop-devnet`, `wrangler.jsonc` `env.devnet`):

```bash
npm run deploy:devnet                         # dry run: preflight + plan, changes nothing
npm run deploy:devnet -- --execute            # D1, role funding, build:devnet + check-bundle, secrets (stdin), deploy, smoke
npm run smoke:devnet && npm run e2e:devnet -- --execute && npm run audit:accuracy
```

**Mainnet** (Worker `cornershop`, `env.mainnet`): the first deploy was `scripts/go-mainnet.mjs` (dry run by default; a
real run needs a TTY and a typed confirmation phrase). Worker fixes after launch go through
`scripts/deploy-mainnet-hotfix.mjs` (docs/OPS-AUTOMATION.md §4). `npm run deploy` refuses on purpose, and nobody runs a
bare `wrangler deploy`: the top level of `wrangler.jsonc` is the old demo Worker config, under the same Worker name as
mainnet.

Smoke test after a deploy: `npm run smoke:devnet`, or `node scripts/smoke.mjs --cluster mainnet` (atlaspad.online,
plus the www and workers.dev redirects).

## Map provider switch

- Default: **Google** when `VITE_GOOGLE_MAPS_KEY` is set.
- `?map=demo` forces the **MapLibre + OpenFreeMap** fallback. A "Basic map" chip appears next to the
  DEMO chip, OSM POIs open an OpenStreetMap block, and Launch is disabled because coins key on Google
  place IDs.
- `?map=google` asks for Google explicitly (it still needs the key).
- If Google fails at runtime (no key, script error, `gm_authFailure`, timeout), the app switches to the
  fallback on its own and shows a toast. The camera carries over.

## Project structure (`src/`)

```
src/
  App.tsx, App.css, PanelHost.tsx   composition, body state classes, layout event, URL router start
  store.ts, types.ts, config.ts     zustand store (demo chain state), shared types, constants
  styles/                           tokens.css (DESIGN §2), global.css, components.css
  lib/                              format, ticker, market (simulated constant-product pool), google loader,
                                    router (deep links + history), escape layers, events, storage, geo, …
  ui/                               shared kit: Button, Modal, PanelShell (desktop panel + mobile sheet),
                                    Tabs, Seg, Fields, Popover, Toasts, Tooltip, HelpPanel, shared sheets
  map/                              MapView, controller, Google + MapLibre adapters, HTML pin layer,
                                    declutter, map controls, Layers tile/popover/sheet
  panel/                            place panel (launched / launchable / OSM), Google UI Kit block, trade box
  launch/  claim/  share/  wallet/  launch, claim and share modals, wallet modal + pill + account menu
  search/  places/                  search pill + dropdown, chips, results list, Near me, Maps-link
                                    parsing/resolving, Google Places (New) / Photon services
  rail/  feed/  landing/  data/     rail + mobile drawer + This area card, Live / Top shops / Launched /
                                    My coins panels, first-visit hero, fictional demo coins + simulator
  chain/  realdata/                 real mode: transactions and quotes (lazy-loaded), Worker API data and polling
  legal/  compliance/  dev/         risk warning + Terms consent, region-block notice, Devnet Test Wallet (devnet only)
```

## Demo mode: simulated vs real

| Real | Simulated (demo mode) |
|---|---|
| The Google map, POIs, Places search/autocomplete, the Places UI Kit place content | Every coin, price, trade, holder count, market cap and fee (a constant-product pool per coin; `CREATOR_FEE_RATE` 0.5%) |
| Pasted-link resolution (Worker → `resolveMapsUrls`, then SSRF-safe manual redirects) | Launches (pump.fun `create_v2` is not called) and the simulator's other traders and launches |
| Listing-phone lookup on the server (only a masked number reaches the browser) | Owner claims: the phone call, code (`482 913`), website / email / manual review checks, payouts |
| Wallet Standard connect / disconnect / silent reconnect (no signing, ever) | Wallet balances (2.41 SOL per new wallet) and the email "embedded wallet" (code `271 604`) |
| Share card (canvas PNG), X intent, copy link, download, Web Share | The 43 seeded coins and their shops. They are **fictional** businesses (`.example` sites, Ofcom drama-range phone numbers) |

Demo persistence is localStorage only, per browser: user-launched coins, local claims, per-wallet balances,
the watch list, Recent, Layers and the hero-seen flag. Google content is never stored. Only Google
place IDs are kept, plus coordinates for at most 30 days. Coin name, ticker and category are always what
the launcher typed.

## Real mode (see INTEGRATION.md)

INTEGRATION.md is the contract for real mode. In short: the RPC provider is Alchemy (server-only key, the browser
goes through `/api/rpc`), D1 enforces one active claim per place, the vault is the `shop-vault` program with an
attestor co-signer, and Privy email wallets are not built yet (email login is hidden in real mode).

- **pump.fun launch**: `create_v2` from `@pump-fun/pump-sdk`, with the shop's vault PDA as the coin's `creator`, so
  100% of creator fees go to the shop's vault. The vault is a `shop-vault` PDA keyed by the hash of the place ID, with
  no admin withdrawal of shop balances.
- **Owner claim**: the Worker's attestor co-signs a claim only after verification (a code on the shop's own website;
  Twilio phone calls are optional and off on mainnet), the program holds it for the public 72-hour window, and the
  guardian can cancel it during that window. Rate limits apply per place and per IP.
- **Indexer**: the Worker's cron reads the chain for prices, trades, holders and fees into D1; the chain is the source
  of truth.
- **Share images**: `/api/og/(c|p)/<id>.png` serves the static `public/og.png` today; per-coin cards are not built
  yet.
