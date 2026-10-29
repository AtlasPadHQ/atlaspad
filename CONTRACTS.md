# AtlasPad (internal id cornershop) — engineering contracts

> **Phase 2 (2026-10-08):** real mode (Solana devnet now, mainnet via `scripts/go-mainnet.mjs`) is specified in
> [`INTEGRATION.md`](INTEGRATION.md), which wins on code shape, wire formats, ownership and ops for real mode. This file
> still governs **demo mode** (`?mode=demo`, the demo-only `npm run build`, the live `cornershop` demo Worker). The
> "never request a signature" rule below applies to **demo mode only**; in real mode the chain layer signs through
> Wallet Standard `solana:signTransaction` (INTEGRATION.md §4.7, §4.9) and never uses `signAndSendTransaction`.

The contract between the four parallel builders (MAP, PANEL, SEARCH, RAIL+FEED) and the shared
scaffold. Read with `BRIEF.md` (product rules, ToS) and `DESIGN.md` (definitive UI spec, §18 =
every control's behaviour). If this file and DESIGN.md disagree on UI, DESIGN.md wins; if they
disagree on code shape, this file wins.

Hard rules for everyone:
- **Every button and control must work** (simulated where it would touch the chain).
- **Demo mode:** never request a wallet signature or send a transaction. Wallet Standard: only
  `standard:connect`, `standard:disconnect`, `standard:events`. (Real mode: INTEGRATION.md §4.7/§4.9.)
- Google ToS: Google place content (name, address, rating, photos, phone, hours) is display-only,
  in memory only, only on a Google map, only via Google's UI Kit in the panel. Persist place IDs
  only (+ coordinates ≤ 30 days). Coin name / ticker / category are always the launcher's input.
  Never use Google photos as coin art. Never show Google data in feeds, leaderboards, pins or share cards.
- The server key (`.env.server`, `GOOGLE_SERVER_KEY`) never enters `src/`. Only `VITE_GOOGLE_MAPS_KEY`.

---

## 1. Ownership map

You may only create or edit files under your own paths. Need a change in a shared file? Ask the
integrator (put it in your result's `sharedChangesNeeded`). You may **import** from any module's
public exports (e.g. Hero imports `resolveMapsLink` from SEARCH).

| Owner | Paths |
|---|---|
| **SHARED** (scaffold / integrator / fixer only) | `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `public/**`, `wrangler.jsonc`, `.env.example`, `.gitignore`, `src/main.tsx`, `src/App.tsx`, `src/App.css`, `src/PanelHost.tsx`, `src/types.ts`, `src/store.ts`, `src/config.ts`, `src/env.d.ts`, `src/styles/**`, `src/lib/**`, `src/ui/**`, `CONTRACTS.md`, `README.md` |
| **MAP** | `src/map/**` |
| **PANEL** | `src/panel/**`, `src/launch/**`, `src/claim/**`, `src/share/**`, `src/wallet/**` |
| **SEARCH** | `src/search/**`, `src/places/**`, `worker/**` |
| **RAIL+FEED** | `src/rail/**`, `src/feed/**`, `src/data/**`, `src/landing/**` |

### DESIGN.md sections per owner

| Owner | DESIGN.md |
|---|---|
| SHARED (done) | §2 tokens · §3 fonts/base CSS · §4 layout skeleton (`#mapwrap`, `.topright`, mobile DEMO, watermark) · §5 z-index · §6 shared button CSS · §6.4 DEMO chip · §6.8 watermark · §8.1/§8.3 panel container + mobile sheet (snaps, drag, fling, keyboard) · §8.8 tabs component · §10.1 shared list CSS + back chip · §12.1 dialog shell + form fields + code input · §12.6 DEMO explainer, Report, Business opt-out, Coin-art lightbox, Help panel · §13.1 toasts · §13.2 tooltips · §13.3 skeleton primitives · §13.4 empty-state component · §13.5 offline toast · §14 keyframes + reduced motion · §15 skip links, Esc layering, `.hit` · §18.4 deep links, history, persistence · §16.13 |
| **MAP** | §4.5 map viewport rules · §5 pin stacking · §6.6 `.mapctl` (desktop locate + zoom) · §6.7 Layers tile + popover + mobile Layers FAB/sheet · §7 (pins, balloon, flashes, fee dots, ticks, low-zoom dots, user dot, POI clicks) · §9.4 provider fallback (MapLibre) · §13.5 map failures · §14 pin rows · §18.1 rows: Locate, Zoom, Layers, Pin, launchable balloon, POI, Empty map |
| **PANEL** | §6.4 wallet pill + account menu (desktop) + mobile account sheet · §8 (all place-panel blocks) · §9 Places UI Kit + demo `.gblock` + OSM block · §12.2 launch · §12.3 claim · §12.4 wallet · §12.5 share + 1200×675 card · §12.6 Unclaimed / Owner popovers, Watch · §16.4–16.6, §16.8–16.10, §16.12 · §18.2 all · §18.3 modal rows |
| **SEARCH** | §6.2 search pill + dropdown (+ mobile logo → drawer, rocket, wallet-mini) · §6.3 chips row + `.chips-next` · mobile locate FAB (§4.4/§6.6 `.m-fab.locate-fab`) · results list panel · research/google.md §1, §2.2, §6 (Places New, link parsing) · Worker `/api/*` · §13.5 Places / `/api/resolve` errors · §16.2 search strings · §18.1 search, link, coin/place/category/recent rows, chips |
| **RAIL+FEED** | §6.1 rail · §6.5 This area · §6.9 mobile drawer · §10.2–§10.5 Live / Top shops / Launched / My coins · §11 hero · §19.2 demo coins · simulator (§8.10 "price ticks every 3–8s", feed pause/stall) · §16.1, §16.7 · §18.1 rail + drawer rows · §18.3 list rows, hero rows |

---

## 2. Module exports (exact — App / PanelHost import these)

All components are **default exports with no props** unless stated.

| File | Export | Rendered by / used by |
|---|---|---|
| `src/map/MapView.tsx` | `default MapView` | App. Must render `<div id="mapwrap"><div id="map" tabIndex={0} aria-label="Map" …/></div>` |
| `src/map/MapControls.tsx` | `default MapControls` | App (desktop/tablet `.mapctl`) |
| `src/map/LayersTile.tsx` | `default LayersTile` | App (desktop tile + popover; mobile Layers FAB + sheet) |
| `src/panel/PlacePanel.tsx` | `default PlacePanel` | PanelHost when `panel === 'place'` |
| `src/launch/LaunchFlow.tsx` | `default LaunchFlow` | App; renders when `modal.kind === 'launch'` |
| `src/claim/ClaimFlow.tsx` | `default ClaimFlow` | App; `modal.kind === 'claim'` |
| `src/share/ShareModal.tsx` | `default ShareModal` | App; `modal.kind === 'share'` |
| `src/share/shareCard.ts` | `renderShareCard(coin: Coin): Promise<Blob>` | ShareModal, launch success |
| `src/wallet/WalletModal.tsx` | `default WalletModal` | App; `modal.kind === 'wallet'` **and** `'account'` (mobile account sheet) |
| `src/wallet/ConnectWalletPill.tsx` | `default ConnectWalletPill` | App inside `.topright`; also does the silent reconnect on load |
| `src/wallet/solanaWallets.ts` | `listWallets(): WalletInfo[]`, `connectWallet(name: string): Promise<{address: string; walletName: string; icon?: string}>`, `disconnect(): Promise<void>`, `createEmailWallet(email: string): {address: string}` | wallet UI, launch step 2, claim step 3 |
| `src/search/SearchBar.tsx` | `default SearchBar` | App |
| `src/search/CategoryChips.tsx` | `default CategoryChips` | App |
| `src/search/NearMe.tsx` | `default NearMe` | App (mobile locate FAB) |
| `src/search/ResultsList.tsx` | `default ResultsList` | PanelHost when `panel === 'results'` |
| `src/search/parseMapsLink.ts` | `looksLikeMapsLink(text: string): boolean`, `parseMapsLink(text: string): ParsedMapsLink \| null` | search, hero |
| `src/search/resolveLink.ts` | `resolveMapsLink(input: string \| ParsedMapsLink): Promise<ResolvedLink>` | search, hero |
| `src/places/index.ts` | `getPlaceDetails(id, source): Promise<Place \| null>` · `autocomplete(q, near?: SearchBias): Promise<PlaceSuggestion[]>` · `searchText(q, near?: SearchBias): Promise<Place[]>` · `searchNearby(center: LatLng, category: CategoryKey \| ChipFilter, radiusM?): Promise<Place[]>` · `placeFromOsmFeature(props: Record<string, unknown>, location: LatLng): Place` · `placeFromParsedLink(p: ParsedMapsLink): Place` · `getListedPhoneMasked(placeId): Promise<ListingContact>` · `getLaunchPrefill(placeId): Promise<{displayName: string \| null; category: CategoryKey}>` · extras: `requestClaimCall(placeId)` / `checkClaimCode(placeId, code)` (Worker `/api/claim/start` + `/verify`, local simulation fallback), `choosePlaceSuggestion`, `resolveGooglePlace`, `areaName`, `cachedPlace`, `isAbortError` · `getListedPhoneMasked` never rejects (failures → `{masked: null, error}`) | everyone; App/router uses `getPlaceDetails` for `/p/<id>` |
| `worker/index.ts` | `default { fetch(request, env: Env) }` (`Env = { ASSETS: Fetcher; GOOGLE_SERVER_KEY?: string }`) | Cloudflare. Routes: `/api/*` (worker/api.ts), `/api/og/(c\|p)/<id>.png` (share image), `/c/<id>` + `/p/<id>` (SPA with Open Graph / Twitter meta for that share URL, worker/share.ts). wrangler `run_worker_first: ["/api/*", "/c/*", "/p/*"]` |
| `src/search/resolveLink.ts` (extras) | `openResolvedLink(result, {launch})`, `resolveErrorMessage(error)` | search link row, hero `try now` |
| `src/search/actions.ts` (extras) | `nearMe()` (store.locate + "n coins within 2 km" toast), `runTextSearch()`, `applyChip()` | mobile locate FAB, desktop Locate, hero `Near me` |
| `src/rail/Rail.tsx` | `default Rail` | App (rail + mobile drawer when `railOpen`) |
| `src/rail/ThisAreaCard.tsx` | `default ThisAreaCard` | App |
| `src/feed/LivePanel.tsx` · `TopShopsPanel.tsx` · `LaunchedPanel.tsx` · `MyCoinsPanel.tsx` | defaults | PanelHost (`live` / `top` / `launched` / `mine`) |
| `src/landing/Hero.tsx` | `default Hero` | App (visible while `!heroDismissed`) |
| `src/data/mockCoins.ts` | `createMockCoins(solUsd?, now?): Coin[]` — 43 FICTIONAL coins (the 8 DESIGN §19.2 Dalston coins with the mock's values + 35 more) (+ `createDemoPlaces()`, `getDemoPlace(id, coins?)`, `createMockActivity(coins, now?)`, `MOCK_PARITY_IDS`, `tradeSizeSol`, `roundSol`, `maxTradeSol`, `activityPlan`) | App seeds; router resolves demo `/p/` ids via `getDemoPlace` |
| `src/data/simulator.ts` | `startSimulator(): () => void` | App (returns cleanup) |

**Stubs.** Every module file starts with `// OWNED BY <builder> - stub, replace`. Replace the
whole file; keep the export names/signatures. `mockCoins.ts` and `simulator.ts` stubs are already
functional (the 8 DESIGN §19.2 coins + a basic trade ticker) so other builders have live data.

---

## 3. Types (`src/types.ts`)

Key shapes (see the file for full docs):

- `LatLng {lat, lng}` · `Bounds {north, south, east, west}` · `Viewport {center, zoom, bounds}` · `UserLocation {location, accuracy, ts}`
- `PlaceSource = 'google' | 'osm' | 'demo' | 'link'` — ids: Google `ChIJ…`, `osm:<type>/<id>`, `demo-<slug>`, `link:<hash>`. Only `google` and `demo` are launchable (`lib/place.isLaunchableSource`).
- `CategoryKey = 'cafe'|'barber'|'kebab'|'pizza'|'bakery'|'pub'|'corner'|'restaurant'|'other'` · `ChipFilter = 'live'|'fees'|cafe|barber|kebab|pizza|bakery|pub|corner`
- `Place {id, source, name ('' when unknown — POI clicks), category, categoryLabel, emoji, address?, city?, location, mapsUrl?, rating?, ratingCount?, photos?, businessStatus?, primaryType?, types?, demo?: DemoPlaceInfo, osm?: OsmPlaceInfo}` — Google fields display-only.
- `LogoSpec = {kind:'sticker', emoji, bg} | {kind:'upload', dataUrl, emoji, bg, credit?}` — uploads resized to ≤512px (`lib/logo.fileToSquareDataUrl`) before saving; `emoji` always present (pins/avatars).
- `CoinPlace {id, source, location, category, emoji, city?, demo?}` — the ToS-safe snapshot stored with a coin (build with `lib/place.coinPlaceFrom`).
- `Coin {placeId, place: CoinPlace, mint (44-char base58 …pump), ticker (A–Z0–9, 2–8, no $), name, description, logo, launchedAt, launcher, priceUsd, priceSol, marketCapUsd, supply, change24h (%), volume24h, holders, feesEarnedUsd, feesClaimedUsd, claimed, ownerVerified, claimPending?, claimedAt?, claimedUsd? (USD paid out by the claim), owner?, payoutWallet?, history: number[48] (24h, oldest→newest), ticks: number[≤60], lastTradeAt?, isUserLaunched?, isDemoSeed?}`
  - Owner states: unclaimed (`!claimed`), pending (`claimPending`), claimed (`claimed && ownerVerified`), you own it (`isOwner(coin, wallet.address)`).
  - Fees waiting = `feesWaiting(coin)` (0 once claimed; claimed ⇒ `feesClaimedUsd === feesEarnedUsd`, new fees follow automatically).
- `Trade {id, placeId, ticker, side, usd, sol, tokens, wallet, ts, signature, isUser?}`
- `FeedEvent` = `trade {side, sol, usd, wallet}` | `launch {wallet}` | `claim {usd, wallet}` | `pump {changePct}`, each with `{id, ts, placeId, ticker, name, emoji, bg}` and optional `isUser`.
- `LaunchDraft {place, name, ticker, description, category, logo, devBuySol}` → `LaunchResult` (`{ok:true, coin, firstBuy}` | `{ok:false, reason:'taken', existing}` | `{ok:false, reason:'no-wallet'|'not-launchable'|'invalid', message}`)
- `TradeResult {side, sol, usd, tokens, priceBefore, priceAfter, trade}` · `UserTradeResult` (`ok` + TradeResult, or `{ok:false, reason:'no-wallet'|'no-coin'|'insufficient'|'invalid', message}`)
- `WalletState {address, kind:'standard'|'email'|null, walletName?, icon?, email?}` · `WalletInfo {name, icon?, installed, pinned, installUrl?, openInAppUrl?}` · `WalletData` (persisted per address)
- `Suggestion = coin {placeId} | place {id, source, main, secondary?, matches?, types?, location?, raw?} | link {parsed} | query {text, filter, area?, count?}` · `PlaceSuggestion` · `SearchBias {center, bounds?, radiusM?}`
- `ParsedMapsLink {url, host, kind:'place'|'short'|'search'|'coords'|'directions'|'unsupported', placeId?, ftid?, candidatePlaceId?, cid?, location?, zoom?, name?, query?}` · `ResolvedLink = place {place} | search {query, location?} | coords {location, zoom?} | error {error:'not-a-link'|'directions'|'not-found'|'network'|'unsupported'}` · `ListingContact {masked, websiteHost?, blocked?: 'no-phone'|'premium'|null, error?: 'unavailable'|'rate-limited'|'not-found', operational?: boolean|null}` (`error` = the lookup itself failed)
- `PanelMode = 'none'|'place'|'results'|'live'|'top'|'launched'|'mine'|'help'` · `ListPanelMode` · `PlaceTab = 'overview'|'coin'|'about'` · `SheetSnap = 'peek'|'half'|'full'` · `HelpSection = 'launching'|'fees'|'claiming'|'real'`
- `ModalState` = `launch {place}` | `claim {placeId, step?: 'verify'|'payout'}` | `share {placeId, variant?: 'coin'|'place'|'launched'|'owner'}` | `wallet {then?: () => void}` | `account` | `demo` | `report {placeId?, reason?}` | `optout {placeId?}` | `lightbox {src, alt, credit?}`
- `Toast {id, msg, kind:'info'|'ok'|'error', icon?, action?: {label, run}}` · `LayersState {mapType:'roadmap'|'hybrid', coins, feeDots, flashes, ticks}` · `FlyTarget {center?, zoom?, bounds?, nonce}`
- `MapAdapter` (MAP-internal, see §6) · `SelectedPin {place, coin?}` · `PlaceClickEvent {id, source, location, place?}`

---

## 4. Store API (`src/store.ts`, zustand v5 + `subscribeWithSelector`)

```ts
import { useStore, useShallow, useCoinList, useCoin, useSelectedCoin, useTopCoins, useTrades, useWalletAddress,
         feesWaiting, filterCoins, coinsInBounds, topByMc, topByFees, newestCoins, totals, tradingNow,
         launchedUnseenCount, holdingsValueUsd, isOwner, isLiveCoin, feedHealth, initialCamera,
         tradeToast, coinCategoryLabel, connectedToast } from '../store';
```
**Selector rule (zustand v5):** a selector that returns a *new* array/object every call must be
wrapped: `useStore(useShallow((s) => topByMc(s.coins, 5)))`, else React throws
"getSnapshot should be cached". Prefer selecting primitives or using the ready hooks.
Outside React: `useStore.getState().action()`, `useStore.subscribe((s) => s.feed, (feed, prev) => …)`.

### State
| Key | Type | Notes |
|---|---|---|
| `provider`, `providerReason` | `'google'\|'demo'`, `'key'\|'no-key'\|'forced'\|'load-failed'` | initial from `config.resolveProvider()` (`?map=demo` forces) |
| `coins` | `Record<placeId, Coin>` | one coin per place |
| `trades` | `Record<placeId, Trade[]>` | newest first, ≤ 100 per coin |
| `feed` | `FeedEvent[]` | newest first, ≤ 150 |
| `solUsd` | number | ~150, nudged by the simulator. SOL figures for USD values: `usd / solUsd` |
| `simLastTickAt` | ms | feed health (`feedHealth(s)` → `'live'\|'paused'\|'stalled'`) |
| `selected` | `{place: Place\|null, status: 'idle'\|'loading'\|'ready'\|'error', error?}` | |
| `panel` / `panelHistory` / `panelNav` | `PanelMode` / `ListPanelMode[]` / `'push'\|'back'` | back chip stack |
| `panelCollapsed` | boolean | desktop collapse tab (selection kept) |
| `placeTab` | `PlaceTab` | place panel tab (store-level so toasts/actions can switch it) |
| `helpSection` | `HelpSection\|null` | Help panel deep-link |
| `results`, `resultsQuery`, `resultsStatus` | | results panel |
| `topShops` | `{sort: 'mcap'\|'fees', scope: 'everywhere'\|'area'}` | Top shops panel state (This area card opens it with scope `'area'`) |
| `category` | `ChipFilter\|null` | chip filter |
| `flyTarget` | `FlyTarget\|null` | camera requests (nonce increments) |
| `viewport` | `Viewport\|null` | published by the map |
| `userLocation`, `locateStatus` | | Near me |
| `layers` | `LayersState` | persisted `cs_layers` |
| `modal` | `ModalState\|null` | one modal at a time |
| `heroDismissed` | boolean | persisted `cs_hero_seen` (storage unavailable → once per page session) |
| `sheetSnap` | `SheetSnap` | mobile sheet |
| `railOpen` | boolean | mobile drawer |
| `searchOpen` | boolean | search dropdown open (mobile full-screen search; App sets `body.search-open`) |
| `searchFocus` | `{nonce, text?, tip?}\|null` | requests for the search bar |
| `toasts` | `Toast[]` (max 1) | |
| `online` | boolean | |
| `recent` | `string[]` | place IDs only, persisted `cs_recent` |
| `launchedSeenAt` | ms | persisted `cs_launched_seen_at` (first visit = now − 1h) |
| `wallet`, `walletConnecting` | `WalletState`, `string\|null` | |
| `solBalance`, `holdings`, `watch` | number, `Record<placeId, tokens>`, `string[]` | simulated, persisted per wallet |

### Actions (signature → semantics)
**Provider**
- `setProvider(provider, reason)` — switch map provider at runtime (MAP: on Google auth/script failure → `('demo','load-failed')`).

**Panels & selection**
- `openPlace(place, opts?: {fly?, zoom?, tab?, from?, launch?})` — select + open the place panel (variant decided by `coins[place.id]`). Pushes the current list panel onto the back stack (or `from`; `from: null` = no back chip). Resets tab to `opts.tab ?? 'overview'`, sheet to Half, closes drawer/search, dismisses the hero, adds to Recent. `fly` → `flyTo(place.location, zoom ?? 16)` (lists/search/deep links; map clicks don't fly — the map pans per §4.5). `launch` → also opens the launch modal if launchable and coin-less.
- `setPlaceLoading(partial?)` — place panel in skeleton state (status `'loading'`), e.g. while resolving a link.
- `setPlaceError(message)` — place panel error state.
- `setPlaceTab(tab)`
- `setPanel(mode)` — open a list panel / help; `'none'` = `closePanel()`. Clears the back stack, keeps the selection, sheet → Half, closes drawer. `'launched'` also marks launches seen.
- `togglePanel(mode)` — rail behaviour (active item again closes).
- `back(): boolean` — back chip: pop to the previous list panel (`panelNav='back'` → PanelShell restores its scroll).
- `closePanel()` — close everything: panel, selection, back stack, results, tab, help section.
- `setPanelCollapsed(bool)`
- `showResults(query, places)` — results panel with places (clears selection).
- `setResultsStatus(status, query?)` — results panel loading/error.
- `openHelp(section?)` — Help panel, optionally expanded at a section.
- `setTopShops(patch)`

**Map**
- `setCategory(filter|null)` / `toggleCategory(filter)` — chips (single-select; again = off).
- `flyTo(center, zoom?)` / `fitBounds(bounds)` — camera requests; MapView executes them (`flyTarget.nonce`).
- `setViewport(v)` — MAP publishes on idle/moveend (also saved to sessionStorage `cs_viewport`).
- `setUserLocation(loc|null)`, `setLocateStatus(s)`
- `locate(): Promise<void>` — Near me: geolocation (user tap only) → user dot + fly to 16; toasts `Location is off. Search for a shop instead.` / `Couldn't find your location.` MAP resets `locateStatus` to `'idle'` when the user drags away.
- `setLayers(patch)` — persisted.

**Chrome**
- `openModal(m)` (replaces any open modal) / `closeModal()`
- `requireWallet(action): boolean` — runs now if connected, else opens the wallet modal with `then: action` (WalletModal must call `then()` after a successful connect; cancel = nothing).
- `toast(msg, kind='info', action?, icon?): id` (replaces the current toast) / `dismissToast(id?)`
- `dismissHero()` (persists), `setSheetSnap(s)`, `setRailOpen(b)`, `setSearchOpen(b)`, `focusSearch({text?, tip?})`, `setOnline(b)` (offline toast), `addRecent(placeId)`, `markLaunchedSeen()`

**Data (all simulated)**
- `seedCoins(coins)` — load demo seeds (keeps user-launched coins, re-applies local claims).
- `seedActivity({trades?, feed?})` — backfill (deduped by id).
- `hydrateUserCoins()` — restore user-launched coins (Google ones older than 30 days are dropped — coordinate TTL), local claims, and a mocked email wallet; rebuilds their Live launch (≤ 6h) / claim rows from the stored records.
- `addCoin(coin, {feed?}): boolean` — someone else's launch (simulator); false if taken.
- `launchCoin(draft): LaunchResult` — as the connected wallet. First launch wins (`'taken'` → existing). Validates name (1–32), ticker `^[A-Z0-9]{2,8}$`, launchable source. Pushes a launch event (`isUser`), then the optional first buy via `userBuy` (capped at balance).
- `applySimulatedTrade(placeId, side, sol, wallet?): TradeResult|null` — random trader; buys spend `sol`, sells return ≈`sol`.
- `applyTickBatch(batch: {placeId, side, sol, wallet?}[]): TradeResult[]` — many in one update.
- `userBuy(placeId, sol): UserTradeResult` / `userSell(placeId, tokens): UserTradeResult` — connected wallet; checks balances; updates `solBalance`/`holdings`; persists.
- `claimFees(placeId, payoutWallet, {owner?}): ClaimResult` — owner = connected wallet unless given (simulator). Moves waiting fees to claimed, sets owner/payout/claimedAt/claimedUsd, pushes a claim event; persists local claims keyed by place but bound to the coin's `mint` (a later coin on the same place never inherits it; `launchCoin` clears the place's old record).
- `setClaimPending(placeId, pending)` — manual review flag. `setPayoutWallet(placeId, address): boolean` — owner only.
- `pushFeed(event)`, `setSolUsd(v)`, `toggleWatch(placeId): boolean|null` (null without wallet)

Every trade: price moves on a virtual constant-product pool (`lib/market`), `feesEarnedUsd += usd × 0.5%`
(claimed coins: also `feesClaimedUsd`), volume/holders/history/ticks/change24h update, a `Trade`
and a `trade` FeedEvent are pushed. MapView flashes pins by watching `feed` for new `trade` events.

**Wallet**
- `setWallet(w)` — connected (loads that address's simulated balances: 2.41 SOL for a new wallet; saves `cs_wallet` = `{kind, walletName}` or `{kind:'email', address, email}`).
- `setWalletConnecting(name|null)` — pill "Connecting…" state.
- `disconnectWallet()` — clears state + `cs_wallet` (call `solanaWallets.disconnect()` first for standard wallets).

---

## 5. Shared libraries (`src/lib`)
| Module | Highlights |
|---|---|
| `format.ts` | `usdPrice` (`$0.000212`, `$0.0₆123`), `usdCompact` (`$212k`), `usdFull` (`$1,240`; `<$0.01` under a cent), `usdOwed` (cent-floored money owed: `<$0.01`, never `$0`), `curvePct` (`0.3%`, `42%`, `99.6%`: rounded down, `100%` only when complete), `solAmount` (`1.2 SOL`), `solApprox` (`≈ 8.27 SOL`), `usdToSolApprox`, `flashLabel` (`+1.2 SOL`/`−2.5 SOL`), `pct` (`▲ 12.4%`), `pctPin` (`▲12%`), `pctSpoken`, `tokenAmount` (`2.36M`), `int`/`holders`, `timeAgo` (`12s`), `timeAgoLong` (`12s ago`), `launchedAgo`, `shortAddr` (`7xKX…3pQa`), `dateLong`, `time24`, `countdown` (`45 s`, `59 m 12 s`, `23 h 59 m`, `2 d 23 h`), `maskPhone` (`+44 20 •••• ••23`), `plural` |
| `ticker.ts` | `TICKER_RE`, `sanitizeTicker` (per keystroke), `tickerFromName`, `validateTicker`, `TICKER_ERROR_MESSAGE`, `isTickerTaken`, `withDollar`. **2–8 chars (DESIGN §12.2 overrides the brief's 2–10).** |
| `categories.ts` | `CATEGORIES` (label, emoji, 6 stickers, icon), `categoryDef/Label/Emoji`, `CATEGORY_OPTIONS`, `COIN_SWATCHES`, `CHIPS`, `chipFromQuery`, `categoryFromGoogle(primaryType, types)`, `categoryFromOsm(class, subclass, name)` |
| `logo.ts` | `stickerFor(id, category)` (deterministic), `defaultLogo`, `logoEmoji`, `logoImage`, `ADDRESS_GRADIENTS`, `addressGradient`, `fileToSquareDataUrl(file, 512)` |
| `market.ts` | `quoteBuy`, `quoteSell`, `quoteSellForSol`, `quote`, `poolDepthUsd`, `initialPriceUsd`, `seriesFor(coin, '1h'\|'24h'\|'7d'\|'all')`, `CHART_RANGES`, `topHoldersFor`, `buildCoin(seed, solUsd)`, `withPrice`, `seedHistory`, `flatHistory`, `randomTradeSol` |
| `fakeSolana.ts` | `fakeWallet(seed)`, `fakeMint(seed)` (…pump), `fakeSignature`, `randomWallet`, `randomSignature`, `isValidSolanaAddress` |
| `rand.ts` | `hashString`, `mulberry32`, `createRng(seed)` (`next/range/int/chance/pick/normal/bytes`), `liveRng()` |
| `storage.ts` | `loadJSON/saveJSON/loadString/saveString/removeKey/storageAvailable` (all try/catch; `'local'\|'session'`) |
| `geo.ts` | `distanceM`, `boundsContains`, `boundsFromPoints`, `padBounds`, `boundsCenter`, `metersPerPixel`, `near`, `sameLatLng`, `isLatLng`, `requestPosition()` (`GeoError` codes) |
| `google.ts` | `importLibrary(name, timeoutMs?)` (official bootstrap port; v=weekly, en-GB/GB; rejects `GoogleMapsError('no-key'\|'script'\|'auth'\|'timeout')`), `onGoogleFailure(cb)`, `googleFailure()`, `isGoogleLoaded()`, `reportGoogleFailure()` |
| `place.ts` | `googlePlaceStub(id, location)`, `placeFromCoin(coin)`, `coinPlaceFrom(place, category, emoji)`, `isLaunchableSource`, `isGooglePlaceId`, `demoPlaceId`, `osmPlaceId`, `sourceFromId`, `mapsUrlFor`, `placePath`, `findCoinByUrlId` |
| `nav.ts` | `openExternal(url)`, `openCoinSite(coin, 'Solscan'\|'DexScreener'\|'pump.fun')` (simulated-coin toast), `openInMaps(place)` (demo-shop toast) |
| `clipboard.ts` | `copyText`, `copyWithToast(text, 'Link copied')` |
| `media.ts` | `MQ`, `useMediaQuery`, `useIsMobile`, `useBreakpoint`, `isMobileNow`, `prefersReducedMotion`, `useReducedMotion` |
| `events.ts` | `LAYOUT_EVENT` (`'cs:layout'`), `LAUNCH_PULSE_EVENT` (`'cs:launch-pulse'`, detail `{fromKeyboard}`) — window events shared by App, MAP and PANEL |
| `escape.ts` | `useEscapeLayer(active, handler, ESC_PRIORITY.x)`, `pushEscapeLayer` — Esc closes one layer per press (dropdown/popover 40 → modal 30 → drawer 20 → panel 10). Return `false` to pass through. |
| `router.ts` | `startRouter`, `parseDeepLink`, `pathForState`, `openDeepLink` (App owns it) |

`config.ts`: `GOOGLE_KEY`, `resolveProvider`, `DEMO`, `CREATOR_FEE_RATE` (0.005), `DEMO_SOL_USD`/`SOL_USD` (150), `DEMO_BALANCE_SOL` (2.41), `PUMP_SUPPLY`, `QUICK_BUY_SOL`, `FIRST_BUY_OPTIONS_SOL`, `SLIPPAGE_PCT`, `NETWORK_FEE_SOL`, `SIM_TRADE_MS` (1200), `SIM_LAUNCH_STEP_MS` (1000), `DEMO_CLAIM_CODE` (482913), `DEMO_EMAIL_CODE` (271604), `RESEND_COOLDOWN_S` (45), `LIMITS`, `INITIAL_CAMERA`, `HERO_CAMERA`, `DEMO_USER_LOCATION`, `LOW_ZOOM` (14), `AREA_MIN_ZOOM` (11), `FOCUS_ZOOM` (16), `OSM_STYLE_URL`, `PHOTON_URL`, `BP`, `APP_ORIGIN`, `links.*` (solscan/dexscreener/pumpfun/googleMapsPlace/shareCoin(mint)/sharePlace/xIntent/unsplash/terms/privacy/walletInstall/walletBrowse), `PINNED_WALLETS`, `STORAGE_KEYS`.

---

## 6. Shared UI kit (`src/ui`, barrel `import { … } from '../ui'`)
`Button` (variants `primary|tonal|outline|amber|text|danger`, `icon`, `iconFill`, `lead`, `trailingIcon`, `block`, `loading`, `tip`) · `IconButton` (`icon`, `label` = aria-label + tooltip) · `Icon` (`name`, `fill`, `size`, `weight`, `spin`) · `Spinner` · `SolGlyph` · `XGlyph` · `AppGlyph` · `WatermarkGlyph` · `BalloonSvg` / `BALLOON_PATH` / `BALLOON_HTML` (for non-React pin layers) · `Chip` · `Seg` (radiogroup) · `Tabs` (+ `tabId`, `tabPanelId`) · `Sk`, `SkRow`, `SkRows` · `Sticker` (coin avatar), `AddrBlob` · `AppIcon`, `Wordmark`, `Brand`, `Watermark` · `Modal` (+ `ModalHeader`, `Stepper`, `ModalFooter`, `DemoNote`, `ModalStep`) · `TextField`, `TextArea`, `SelectField`, `Checkbox`, `OptionCard`, `OptionGroup`, `CodeInput`, `Switch`, `ToggleRow` · `Popover` · `EmptyState` · `Change` + `useTickFlash` · `DemoChip`, `BasicMapChip` · `PanelShell`, `BackChip`, `LIST_PANEL_LABELS` · `HelpPanel` · `SharedModals` (DEMO explainer, Report, Opt-out, Lightbox) · `Toasts` · `TooltipLayer` (any element with `data-tip="…"` gets a tooltip) · `SkipLinks` · `usePresence`, `useLatest`.

---

## 7. Conventions every builder must follow

**CSS.** Plain CSS, tokens only (`src/styles/tokens.css` = DESIGN §2 verbatim). Shared CSS already
covers: base/utilities (`.ms`, `.num`, `.up/.down`, `.mono`, `.sr`, `.muted`, `.amb`, `.dot-sep`,
`.hit`, `.m-only`, `.d-only`), keyframes (`ping`, `flash`, `rowin`, `sk`, `cs-spin`, `cs-shake`,
`cs-pop`, `cs-burst`, `cs-tick-up/down` …), buttons, chip, DEMO chip, seg, tabs, ticker, chg, sol,
demo-note, sticker, blob, skeleton, empty, panel shell + sheet, sec-title/sec-h/foot/irow/info/trow,
list panels (`.lp-h`, `.lp-tabs`, `.feed`, `.frow`, `.rank`, `.area-live`), help, dialog + all
§12.1 parts (`.stepper`, `.tf*`, `.dlg-box`, `.dlg-buy`, `.dlg-f`, `.check`, `.opt`, `.code6`,
`.dlg-center`, `.art`, `.emoji-pick`, `.lbl2`), switch, popover, toast, tooltip. Each module puts its
own CSS next to its components (e.g. `src/map/map.css`) and imports it from its component; use the
DESIGN class names (`.rail-item`, `.pin`, `.ph-coin`, `.act`, …). Never a raw z-index number — use
the `--z-*` tokens.

**Body state classes (set by App — don't set them yourself):** `panel-open`, `panel-collapsed`,
`live-on` (any non-place panel), `hero-on`, `lowzoom` (viewport.zoom < 14), `search-open`,
`modal-open`, `drawer-open`, `offline`; `data-provider="google|demo"`, `data-sheet="peek|half|full|none"`.
`--sheet-h` on `:root` is set by PanelShell (mobile). Use them for responsive positioning.

**Layout event.** After panel open/close/collapse, sheet snaps and hero dismissal, App dispatches
`window` event `LAYOUT_EVENT` from `src/lib/events.ts` (`'cs:layout'`, 320ms desktop / 460ms mobile).
MapView calls `adapter.resize()` on it. The launchable balloon click dispatches `LAUNCH_PULSE_EVENT`
(map → place panel: scroll to top + pulse Launch).

**Top-right width.** App publishes the width of `.topright` as `--topright-w` on `:root`; the desktop
chips row ends 20px before it (`right: calc(var(--topright-w) + 48px)`), so the Basic map chip or a
connected wallet pill never overlap the chips. `.m-fab` (44px mobile FAB base) is shared CSS.

**Rendering-time watchdogs.** Anything that waits for Google's UI Kit element or a map to *render*
must not use wall-clock timeouts: background tabs render no frames, so IntersectionObserver / rAF /
MapLibre `load` never fire there. GoogleBlock counts rAF time; MapLibre resolves on `style.load`.

**Places UI Kit class names.** React 18 writes `className` on custom elements as a literal
`classname` attribute; use `class="gmp"` / `class="gmp-compact"` (typed in `src/env.d.ts`).

**Panels.** Content components render inside `PanelShell` (don't render your own `.panel`). The
first 60px of desktop content sits under the floating search pill: place panel starts with its
240px hero, list panels use `.lp-h` (padding-top 76px). Mark the sheet drag zone (your header) with
`data-sheet-drag`. On mobile render `<BackChip inline />` left of your title (desktop: PanelShell
renders it). PanelShell resets scroll when the place/mode changes and restores it on `back()`.
Content is unmounted during the 200/300ms exit animation.

**Modals.** Render your modal unconditionally in your component and pass `open={modal?.kind === 'x'}`
to `<Modal>`; keep the last props via `useLatest` while it animates out. Busy steps: `busy` (Esc,
scrim and close ignored). Footers use `<ModalFooter note="Demo — no real transaction">`. The
router adds a history entry per open modal (browser Back closes it).

**Map (MAP).** Only `src/map` talks to the adapter. Follow store → adapter: `coins` + `category` +
`layers` → `setCoinPins(filterCoins(...))` (`layers.coins=false` → no pins); `selected.place` (+ coin) →
`setSelectedPlace`; `results` → `setResultPins`; `userLocation` → `setUserLocation`; `flyTarget` →
`flyTo`/`fitBounds` (respect reduced motion: `setCenter`/`setZoom` only); `layers.mapType` →
`setMapType`; new `feed` trade events → `flashCoin(placeId, side, flashLabel(side, sol))` when
`layers.flashes`. Adapter → store: POI click → `openPlace(googlePlaceStub(id, latLng))` (no Places fetch:
the panel renders Google's UI Kit), coin pin click → `openPlace(placeFromCoin(coin))`, OSM POI →
`openPlace(placeFromOsmFeature(props, latLng))`, moveend → `setViewport`, drag → `setLocateStatus('idle')`.
Google loads via `lib/google.importLibrary('maps')`; on `onGoogleFailure` or load error →
`setProvider('demo', 'load-failed')` and mount MapLibre (`await import('maplibre-gl')` — keep it a
lazy chunk; its CSS is already imported in main.tsx). Initial camera: `initialCamera(!heroDismissed)`.

**Search (SEARCH).** Read `searchFocus` (focus/prefill/tip) and publish `setSearchOpen`. Use
`store.viewport` for location bias (`SearchBias`). Coins section searches `store.coins` (ticker/name).
Google: `AutocompleteSuggestion` with `AutocompleteSessionToken`; choosing a business ends the session
with a `fetchFields` (only fields you need); never legacy services. Demo provider: Photon. Worker
`/api/resolve` + `/api/listing/:placeId` with `env.GOOGLE_SERVER_KEY` (dev: `wrangler dev` on :8787 —
Vite proxies `/api`; put the key in `.dev.vars`). Treat `/api` failures as "service unavailable".

**Panel (PANEL).** Coin for the selected place: `useSelectedCoin()`. Trades: `useTrades(placeId)`.
Buy/Sell: `requireWallet(() => …)` then `userBuy`/`userSell` after a 1.2s `SIM_TRADE_MS` spinner;
toast `tradeToast(result, ticker)` with action `View` → `setPlaceTab('coin')`. Launch: `getLaunchPrefill`
for the h2/prefill (display only), `launchCoin(draft)`, then `openPlace(placeFromCoin(coin))`. Claim:
`getListedPhoneMasked` → simulated call → code `DEMO_CLAIM_CODE` → `claimFees`. Links via `lib/nav`.
Share card: our own drawing only (no Google tiles/content). Wallets: Wallet Standard `getWallets()`,
`standard:connect` only; `setWalletConnecting` → `setWallet` → toast `connectedToast(address)`.

**Rail+feed (RAIL+FEED).** Rail items → `togglePanel(mode)`; app icon → `closePanel()` +
`setCategory(null)` (desktop) / `setRailOpen(true)` (mobile, from the search logo). Feed rows →
`openPlace(placeFromCoin(coin), { fly: true })` (back chip is automatic). This area → `setTopShops({scope:'area'})`
+ `setPanel('top')`. Simulator: `applySimulatedTrade`/`applyTickBatch`, `addCoin` (fictional places
only), `claimFees(…, {owner})`, `pushFeed` (pump), `setSolUsd`; pause when the tab is hidden; return a cleanup.

**Accessibility.** Icon-only buttons: `IconButton` (label + tooltip). Mobile hit areas ≥ 44px
(`.hit`). Up/down never colour-only (▲/▼, Bought/Sold). `translate="no"` on tickers, mints, wordmark.

---

## 8. Commands
```bash
npm install
npm run dev        # http://localhost:5173 (the Google browser key only allows :5173 and :4173)
npm run typecheck  # tsc -b (app + vite config + worker)
npm test           # vitest run (src/**/*.test.ts, worker/**/*.test.ts)
npm run build      # typecheck + vite build → dist/
npm run preview    # http://localhost:4173
npm run deploy     # REFUSES (Phase 2): the demo Worker is redeployed only by the integrator, by hand
npm run build:devnet / build:mainnet   # real-mode bundles → dist-devnet / dist-mainnet (INTEGRATION.md §1.3)
npm run deploy:devnet                  # scripts/deploy-devnet.sh (dry run; add -- --execute)
```
DEV QA states (mock parity): `/?state=hero`, `/?state=unlaunched`, `/?state=launch`, `/?state=live`,
`/?search=1`, `/?map=demo`, deep links `/c/kebab`, `/c/<mint>`, `/p/<placeId>`.
## 9. Integration decisions (integrator, 2026-10-07)
- Hero `try now` with an empty input dismisses the hero and focuses search with the link tip
  (DESIGN §18.3; fixer round 1 reverted the earlier "open $KEBAB" deviation); a link uses
  `openResolvedLink(result, {launch: true})` like the search link row; every `Near me` uses `nearMe()`.
- `This area` opens Top shops scoped to the area (DESIGN §18.1).
- Category chips filter the pins and also list nearby shops of that category (results panel).
- Search Enter with nothing highlighted: Maps link → open it; exact ticker → open the coin; else a
  text-search results list.
- ClaimFlow keeps its local claim simulation (deterministic for demos); `requestClaimCall` /
  `checkClaimCode` exist for the Phase-2 Twilio wiring.
- The Help panel carries the not-affiliated disclaimer and the takedown routes (Business opt-out, Report).
- The watermark measures Google's (or MapLibre's) attribution after every layout change and hides
  (visibility) while it would touch it, at any width (fixer round 1; replaces the old "<1280px with a
  panel open" rule, which missed tablet widths with the panel closed).
- Fixer round 1 deviations (DESIGN §6.8/§17 "never cover Google's logo" wins over the literal values):
  mobile Full snap stops at `100dvh − 126px − safe-top` (`--sheet-full`): search pill, DEMO chip
  (moved into the chips-row slot at Full; chips, Layers and locate FABs hide) and Google's logo all
  sit above the sheet. Mobile toasts sit above the locate FAB (`80px` / `sheet + 96px`) and over the
  sheet's bottom at Full.
- Every app region has its own error boundary (src/ui/ErrorBoundary): chrome regions re-mount on
  their own, the panel shows "Try again", a modal crash closes the modal; a root boundary shows Reload.
- The search category row ("Kebab shops near … · 20 places") shows a count only once it is known, and
  it is the length of the very list the row / chip opens (shared, 2-min cached nearby search).
- Share URLs `/c/<id>` and `/p/<id>` get Open Graph meta from the Worker; the share image is a static
  1200×630 card (`public/og.png`) until per-coin server rendering lands (Phase 2).
- Production builds ship no source maps.

## 10. Phase 2 integration decisions (integrator, 2026-10-08)
- Live panel extras that DESIGN §10.2 does not list (kept, harmless, follow §13.4 tone):
  1. the global stats line under the Live header: **demo only**; hidden in real mode because the client holds only part
     of the registry;
  2. `pump` feed events: demo simulator only, counted under Trades;
  3. the `Quiet right now` / `Nothing here yet` empty states with `Show all`.
- Real mode keeps every Phase-1 control; the demo ClaimFlow keeps its local simulation. The real claim modal is
  `src/claim/RealClaimFlow.tsx` (INTEGRATION.md §7.5): payout goes to the connected wallet only (it must sign
  `request_claim`), so "Another address" is hidden in real mode.
- Material Symbols is loaded as a subset (`index.html` `icon_names=`, alphabetical). **Every new icon name must be
  added there**, otherwise it renders as its literal name (Phase 2 added `block`, `cloud_off`, `phone_disabled`,
  `science`, `settings`, `shield`, `task_alt`, `water_drop`).
