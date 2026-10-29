# AtlasPad (internal id cornershop) — DESIGN.md (definitive UI spec)

Version 1.0 · 2026-10-07 · Owner: design · Status: **build from this**

> **Chain change (user, 2026-10-07):** CORNERSHOP launches on **Solana** via **pump.fun**, not Robinhood Chain.
> Everywhere in this spec: amounts are **SOL**, wallets are **Solana wallets via Wallet Standard** (Phantom, Solflare, Backpack) plus "Continue with email",
> coin addresses are **base58 mints ending in `pump`**, explorer links go to **Solscan**, chart/trade links go to **DexScreener / pump.fun**.
> The mock (and BRIEF.md) still show ETH / `0x…` / Robinhood Chain — **this document overrides them**. There is no ETH, no `0x`, no chain switching anywhere in the product.

## 1. How to use this document

**Sources of truth, in order**
1. This file (DESIGN.md). Where it differs from the mock, this file wins; every such difference is listed in §19.
2. The static mock (not in the public repository; live at https://cornershop-mock.tiejiucai.workers.dev, states `?state=hero`, `?state=unlaunched`, `?state=launch`, `?state=live`, `?search=1`). The shipped app is at https://atlaspad.online.
3. `BRIEF.md` (internal, not published) for product rules, Google ToS rules and tech constraints (except the chain, see above).

**Rules for engineers**
- Values in this file are literal. If a px value, colour, string or duration is written here, use exactly that. Do not "round to the nearest Tailwind step"; there is no Tailwind.
- Implement styles as plain CSS with the tokens in §2 (one `tokens.css` imported first). Component CSS may only reference tokens or the literal values written in this spec.
- Every interactive control has a defined behaviour in §18. **Nothing is decorative.** If you build a control that is not in §18, stop and ask design.
- Class names in this spec (`.rail-item`, `.ph-coin`, `.act`…) come from the mock. Keep them as the CSS class names of the React components (CSS modules are fine as long as the generated names are stable in tests via `data-testid`).
- Prototype phase: all prices, trades, launches, buys, sells and claims are **simulated**. Never request a signature or send a transaction. The only Wallet Standard features we call are `standard:connect`, `standard:disconnect` and `standard:events`. Every simulated action shows the "Demo — no real transaction" note and the DEMO chip stays visible.
- Light theme only. Set `color-scheme: light` on `:root`. No dark mode in v1 (the Google default basemap is light).

**Naming**
- *Coin* = a pump.fun token launched for one Google Place ID. *Shop* = the business. *Launcher* = whoever launched it. *Owner* = the verified business owner (after claim).
- *Launched place* = a place with a coin. *Launchable place* = a real Google POI with no coin yet. *Demo shop* = a seeded FICTIONAL shop (never a real business).
- *Coin name* and *ticker* are always the launcher's typed values (never Google's `displayName` as stored data).

## 2. Design tokens

### 2.1 Mock tokens (copy verbatim — do not edit values)
This is the mock's `:root` block exactly as shipped (comments included). It goes first in `src/styles/tokens.css`.

```css
:root{
  /* neutrals (measured on maps.google.com, Oct 2026) */
  --cs-surface:#ffffff;
  --cs-rail:#f3f8f4;            /* Maps rail #f4fbfc, nudged to our green */
  --cs-surface-2:#f1f4f2;       /* fills: inputs, close buttons, skeleton base */
  --cs-surface-3:#e8ede9;
  --cs-text:#1f1f1f;
  --cs-text-2:#5e5e5e;
  --cs-text-3:#80868b;
  --cs-icon:#5e5e5e;
  --cs-divider:#e3e3e3;
  --cs-outline:#c7c7c7;
  --cs-outline-2:#dadce0;
  --cs-map-bg:#e8e6e1;
  --cs-scrim:rgba(31,31,31,.42);
  --cs-state-hover:rgba(31,31,31,.06);
  --cs-state-press:rgba(31,31,31,.12);

  /* brand */
  --cs-green:#0e7c47;
  --cs-green-hover:#0b6b3d;
  --cs-green-press:#095c34;
  --cs-green-bright:#15a35a;
  --cs-green-container:#d7f5e1;
  --cs-on-green-container:#0b4d2b;
  --cs-green-tint:#eef8f1;
  --cs-amber:#b45f00;
  --cs-amber-bright:#f59e0b;
  --cs-amber-container:#ffedd0;
  --cs-on-amber-container:#6b3a00;
  --cs-up:#0e7c47;
  --cs-up-bg:#e3f5e9;
  --cs-down:#cc2f3a;
  --cs-down-bg:#fde8e9;
  --cs-star:#f2a71b;
  --cs-loc:#2d6cdf;
  --cs-focus:#0e7c47;

  /* type */
  --cs-font:"Roboto Flex",Roboto,"Helvetica Neue",Arial,sans-serif;
  --cs-icons:"Material Symbols Rounded";

  /* radii */
  --cs-r-xs:4px; --cs-r-sm:8px; --cs-r-md:12px; --cs-r-lg:16px; --cs-r-xl:24px; --cs-r-2xl:28px; --cs-r-pill:999px;

  /* elevation (Maps-measured) */
  --cs-elev-search:0 2px 4px rgba(0,0,0,.2),0 -1px 0 rgba(0,0,0,.02);
  --cs-elev-1:0 1px 2px rgba(60,64,67,.3),0 1px 3px 1px rgba(60,64,67,.15);
  --cs-elev-2:0 1px 2px rgba(60,64,67,.3),0 2px 6px 2px rgba(60,64,67,.15);
  --cs-elev-3:0 1px 3px rgba(60,64,67,.3),0 4px 8px 3px rgba(60,64,67,.15);
  --cs-elev-ctrl:0 1px 4px rgba(0,0,0,.3);
  --cs-elev-sheet:0 -1px 3px rgba(60,64,67,.16),0 -4px 12px 2px rgba(60,64,67,.12);

  /* z */
  --z-map:0; --z-pins:10; --z-map-ctrl:20; --z-float:30; --z-panel:40; --z-rail:50; --z-search:60; --z-sheet:70; --z-scrim:90; --z-modal:100; --z-toast:110; --z-tooltip:120;

  /* motion */
  --cs-ease:cubic-bezier(.2,0,0,1);
  --cs-ease-decel:cubic-bezier(0,0,0,1);
  --cs-ease-accel:cubic-bezier(.3,0,1,1);
  --cs-dur-1:100ms; --cs-dur-2:200ms; --cs-dur-3:300ms; --cs-dur-4:450ms;

  /* layout */
  --rail-w:72px; --panel-w:408px; --panel-gutter:8px;
  --search-w:392px; --search-h:48px;
  --sheet-h:50dvh;
}
@media (max-width:767px){ :root{ --sheet-h:52dvh } }
```

### 2.2 Additions (values the mock hard-codes, plus what the new screens need)
Append this block after 2.1. Every literal colour the mock used inline now has a token; components must use the token.

```css
:root{
  color-scheme: light;

  /* literals promoted from the mock */
  --cs-amber-text-2:#7d5426;     /* fees card body, dlg-box small text */
  --cs-amber-hover:#563000;      /* .btn-amber:hover */
  --cs-handle:#c4c7c5;           /* sheet / hero grab handle */
  --cs-chip-hover:#f5f7f6;       /* .chip:hover */
  --cs-ctl-hover:#f5f5f5;        /* .ctl:hover */
  --cs-star-empty:#dadce0;       /* empty stars */
  --cs-hero-placeholder:#d9d4cc; /* panel hero before image loads */
  --cs-watermark:#6b6f73;        /* CORNERSHOP map watermark text */
  --cs-toast-bg:#1f1f1f;
  --cs-loc-halo:rgba(45,108,223,.16);
  --cs-pin-ring:0 0 0 2px #fff,0 1px 3px 1px rgba(0,0,0,.28);
  --cs-pin-halo:-1.5px -1.5px 0 #fff,1.5px -1.5px 0 #fff,-1.5px 1.5px 0 #fff,1.5px 1.5px 0 #fff,0 -1.5px 0 #fff,0 1.5px 0 #fff,-1.5px 0 0 #fff,1.5px 0 0 #fff,0 0 4px #fff;
  --cs-balloon-shadow:drop-shadow(0 2px 3px rgba(0,0,0,.3));
  --cs-seg-on-shadow:0 1px 2px rgba(60,64,67,.25);
  --cs-app-icon-shadow:0 1px 2px rgba(14,124,71,.35);
  --cs-lhero-bg:radial-gradient(120% 90% at 70% 10%,#e8f8ee 0%,#d2f0dd 45%,#bfe6cf 100%);
  --cs-spark-up-fill:#15a35a;    /* gradient stop, opacity .22 → 0 */
  --cs-spark-down-fill:#cc2f3a;  /* gradient stop, opacity .18 → 0 */

  /* Solana (currency glyph ONLY — never as a UI accent) */
  --cs-sol-1:#9945ff;
  --cs-sol-2:#14f195;
  --cs-sol-chip:#000000;

  /* extra radii used by the mock */
  --cs-r-2xs:6px;               /* ticker badge, hero "Coin art" button, photo badge */
  --cs-r-thumb:10px;            /* rail place thumb, hero brand icon */

  /* spacing scale (4px grid; all mock paddings are on it except the noted 14/15/18/22 literals) */
  --cs-sp-1:4px; --cs-sp-2:8px; --cs-sp-3:12px; --cs-sp-4:16px; --cs-sp-5:20px; --cs-sp-6:24px; --cs-sp-8:32px;

  /* type roles (see §3.2) */
  --cs-type-display:750 32px/38px var(--cs-font);
  --cs-type-title-l:600 22px/28px var(--cs-font);
  --cs-type-title:500 22px/28px var(--cs-font);
  --cs-type-title-s:600 16px/22px var(--cs-font);
  --cs-type-body-l:400 16px/24px var(--cs-font);
  --cs-type-body:400 14px/20px var(--cs-font);
  --cs-type-label:500 14px/20px var(--cs-font);
  --cs-type-caption:400 12px/16px var(--cs-font);
  --cs-type-overline:600 11px/16px var(--cs-font);
  --cs-mono:ui-monospace,"SF Mono",Menlo,monospace;

  /* layout additions */
  --tap-min:44px;
  --chips-left:529px; --chips-left-panel:508px; --chips-right:396px;
  --sheet-peek:148px; --sheet-half:52dvh; --sheet-full:calc(100dvh - 72px);
  --dialog-w:520px;
  --drawer-w:min(320px,85vw);
  --skeleton-shine:linear-gradient(90deg,var(--cs-surface-2) 0%,var(--cs-surface-3) 50%,var(--cs-surface-2) 100%);
}
```

### 2.3 Colour usage rules

| Token | Use for | Never use for |
|---|---|---|
| `--cs-green` | Primary buttons, active tab, links, selected pin balloon, app icon, focus ring | Large background areas |
| `--cs-green-bright` | Pin rings, live dots, low-zoom dots, sparkline fill stop | Text (contrast 3.3:1) |
| `--cs-green-container` / `--cs-on-green-container` | Tonal fills: action circles, active rail indicator, ticker badge, selected chip | Body text on white |
| `--cs-amber*` | Money waiting for owners: fees card, fee dot, "Fees waiting" chip, DEMO chip, claim CTA | Price changes (use up/down) |
| `--cs-up` / `--cs-down` | Price change, Bought/Sold, buy/sell flash | Buttons |
| `--cs-loc` | User location dot only | Anything else (it is the only blue in the product) |
| `--cs-sol-*` | The 20px SOL currency glyph only | Accents, buttons, gradients in chrome |
| `--cs-text-3` | Timestamps, overlines, hints that are also conveyed elsewhere | Any required information (fails AA for small text: 3.7:1) |

## 3. Typography & icons

### 3.1 Font loading (in `index.html` `<head>`, in this order)
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wdth,wght@8..144,100..151,400..800&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,400..700,0..1,0&icon_names=account_balance_wallet,add,add_photo_alternate,add_shopping_cart,arrow_back,arrow_downward,arrow_drop_down,arrow_left,arrow_right,arrow_upward,bakery_dining,bolt,call,candlestick_chart,celebration,check,check_circle,chevron_right,close,content_copy,content_cut,download,edit,error,expand_more,flag,help,info,ios_share,kebab_dining,language,layers,leaderboard,link,local_cafe,local_pizza,location_on,lock,logout,mail,my_location,near_me,notifications,notifications_active,open_in_new,payments,phone_in_talk,photo_camera,photo_library,progress_activity,public,refresh,remove,rocket_launch,schedule,search,search_off,sell,share,sports_bar,storefront,support_agent,toll,verified,warning,wifi_off&display=block" rel="stylesheet">
```
- Roboto Flex is variable (opsz 8–144, wdth 100–151, wght 400–800). `body` sets `font-optical-sizing:auto` and `-webkit-font-smoothing:antialiased`.
- The icon URL is the mock's list **plus** the icons the new screens need (`arrow_back`, `arrow_right`, `candlestick_chart`, `celebration`, `check_circle`, `download`, `edit`, `error`, `flag`, `language`, `lock`, `logout`, `mail`, `notifications_active`, `phone_in_talk`, `photo_camera`, `progress_activity`, `refresh`, `search_off`, `support_agent`, `warning`, `wifi_off`) and the weight axis widened to `400..700` so the mock's `'wght' 500/700` icon settings actually render. `icon_names` **must stay alphabetical** or Google Fonts returns 400. Adding an icon = add it here, alphabetically.
- `display=block` for icons (no ligature text flash); `display=swap` for Roboto Flex.

### 3.2 Base CSS (from the mock, verbatim)
```css
*{box-sizing:border-box}
[hidden]{display:none !important}
html,body{margin:0;height:100%;overflow:hidden}
body{font-family:var(--cs-font);color:var(--cs-text);background:var(--cs-map-bg);-webkit-font-smoothing:antialiased;font-optical-sizing:auto}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
input{font:inherit;color:inherit}
.ms{font-family:var(--cs-icons);font-weight:normal;font-style:normal;font-size:24px;line-height:1;letter-spacing:normal;text-transform:none;display:inline-block;white-space:nowrap;direction:ltr;-webkit-font-smoothing:antialiased;font-feature-settings:'liga';font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24;user-select:none;flex:none}
.ms.fill{font-variation-settings:'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24}
.num{font-variant-numeric:tabular-nums}
.up{color:var(--cs-up)} .down{color:var(--cs-down)}
:focus-visible{outline:2px solid var(--cs-focus);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px}
```
Icons are `<span class="ms" aria-hidden="true">name</span>` (ligatures). Icon-only buttons always carry `aria-label`.

### 3.3 Type scale (every text style in the product)

| Role | Size / line | Weight | Tracking | Extras | Where |
|---|---|---|---|---|---|
| Hero display | 32/38 (mobile 28/34) | 750 | -0.6px | `font-variation-settings:'opsz' 40` | Hero card h1 |
| Coin price | 28/34 | 650 | -0.3px | tabular, `'opsz' 32` | Coin summary |
| Panel title | 22/28 | 500 | 0 | `'opsz' 28` | `.ph-title`, `.gb-name` |
| Dialog / panel heading | 22/28 | 600 | 0 | — | `.dialog h2`, Live/Top shops h1 |
| Section title | 16/22 | 600 | 0 | — | `.sec-title`, "Recent trades", fees h3 (amount `b` at 800) |
| Card heading | 16/20 | 600 | 0 | — | "This area" |
| Body large | 16/24 | 400 | 0.1px | — | Hero paragraph (mobile 15/22), area row t1 |
| Search input | 15/24 (mobile 16) | 400 | 0.1px | placeholder 14px (mobile 15px), `--cs-text-2` | Search pill |
| Body | 14/20 | 400 | 0.1px | — | `.ph-row`, `.irow`, `.srow`, toast, dialog sub |
| Label | 14/20 | 500 (tabs, chips) / 600 (buttons) | 0.1px | — | Tabs, chips, buttons, wallet pill |
| Ticker badge | 13/24 | 700 | 0.2px | — | `.ticker` |
| Pin ticker | 13.5/17 (selected 15/19) | 750 | 0.1px | white halo `--cs-pin-halo` | `.pin .lb b` |
| Pin meta | 11/14 (selected 12) | 600 | 0 | tabular | `.pin .lb small` |
| Caption | 12/16 | 400 (rail/action labels 500, active 600) | 0.2px | — | Unclaimed line, stat keys, rail labels |
| Overline | 11/16 | 600 | 0.6px | uppercase, `--cs-text-3` | Suggestion headers "Coins" / "Places" |
| Micro | 11/16 | 400–600 | 0 | — | `.demo-note`, `.hero-credit`, layer tile label (11/13) |
| Badge | 11/14 | 700 | 0 | tabular | Rail badge |
| Pin tag | 10.5/18 | 700 | 0 | — | Buy/sell flash tag |
| Wordmark | 16/20 (watermark 15/20) | 800 | 0.6px (watermark 0.4px) | `font-stretch:120%` (watermark 118%) | "CORNERSHOP" |
| Mono | 13px (trade rows 12px, feed 11px) | 400 | 0 | `--cs-mono` | Addresses, mints |

### 3.4 Number & text formatting (apply everywhere)

| Value | Format | Examples |
|---|---|---|
| Coin price (USD) | `$` + 3 significant figures; up to 6 decimals; below $0.000001 use subscript-zero `$0.0₆123` | `$0.000212`, `$0.0184`, `$1.27` |
| Market cap, volume (USD) | Compact, ≤3 sig figs, lowercase `k`, uppercase `M`/`B` | `$212k`, `$1.2M` |
| Fees waiting (USD, primary) | Panel/card: full with thousands separator `en-GB`; chips/area/pins/hero stats: compact | `$1,240` / `$1.2k`, `$18.4k` |
| Fees (SOL, secondary) | `≈ ` + SOL, 2 decimals (0 decimals ≥ 100 SOL), always after the USD value in `--cs-text-2` (or `--cs-amber-text-2` on amber) | `≈ 8.27 SOL` |
| SOL amounts (trades, flashes, inputs) | Trim trailing zeros, max 3 decimals, suffix ` SOL` | `1.2 SOL`, `0.05 SOL` |
| Flash tag | Sign + amount | `+1.2 SOL`, `−2.5 SOL` (U+2212 minus) |
| % change (panel, lists) | Arrow + space + 1 decimal | `▲ 12.4%`, `▼ 3.2%` |
| % change (pins) | Arrow, no space, 0 decimals | `▲12%` |
| Holders | Integer, `en-GB` separators | `1,284` |
| Wallet address (base58) | First 4 + `…` + last 4, mono | `7xKX…3pQa` |
| Mint (pump.fun, base58 ending `pump`) | First 4 + `…` + last 4, mono → always ends `…pump` | `BkT7…pump` |
| Relative time | `12s`, `48s`, `2m`, `3h`, `3d` (rows); `12s ago` (feed); `launched 3d ago` (panel) | — |
| Ticker | `$` + 2–8 chars `A–Z0–9`, always uppercase | `$KEBAB` |

Demo FX for the prototype: **1 SOL = $150.00** (constant `DEMO_SOL_USD`). So `$1,240 ≈ 8.27 SOL`.

## 4. Layout & breakpoints

| Name | Range | Structure |
|---|---|---|
| Mobile | `max-width:767px` | Full-bleed map, search pill + scrolling chips on top, FABs, draggable bottom sheet, drawer for navigation |
| Tablet | `768px–1023px` | Desktop structure (rail + side panel) with the compact overrides in §4.3 |
| Desktop | `min-width:1024px` | Rail + side panel + floating chrome exactly as the mock |

All chrome is `position:fixed`. The map is the only thing that scrolls/pans; `html,body` never scroll (`overflow:hidden`). No horizontal page scroll at any width ≥ 320px.

### 4.1 Desktop (≥1024) — panel closed
```
x: 0      72  88                  480       529 ............ (100vw-396)  (100vw-28)
   ┌──────┬───────────────────────────────────────────────────────────────────────┐
   │ RAIL │   [ SEARCH PILL 392×48 ]   [chip][chip][chip]…fade  (›)   [DEMO][Wallet]│ y=12
   │ 72w  │   ┌ THIS AREA 392w ┐                                                   │ y=72
   │      │   └────────────────┘                    MAP (left:72 → right:0)        │
   │      │                                                                        │
   │      │   ┌Layers┐                                                     [◎]     │
   │      │   │79×79 │                    CORNERSHOP (watermark)          [+][−]   │
   └──────┴───────────────────────────────────────────────────────────────────────┘
```

| Element | Position / size |
|---|---|
| `.rail` | `left:0; top:0; bottom:0; width:72px` |
| `#mapwrap` | `left:72px; top:0; right:0; bottom:0` |
| `.search` | `left:88px; top:12px; width:392px`; box height 48px |
| `.chips` | `left:529px; top:13px; height:48px; right:396px`; chips 32px tall, vertically centred; gap 6px; `padding-left:4px`; right-edge fade `mask-image:linear-gradient(90deg,#000 calc(100% - 64px),transparent calc(100% - 20px))` |
| `.chips-next` | `top:21px; right:400px; 32×32` circle |
| `.topright` | `right:28px; top:12px; height:40px; gap:12px` (DEMO chip 32h, wallet pill 40h) |
| `.area` ("This area") | `left:88px; top:72px; width:392px` |
| `.herocard` (first visit) | `left:88px; top:72px; width:440px` (replaces "This area") |
| `.mapctl` | `right:20px; bottom:40px`; column, gap 8px: locate 32×32, zoom group 32×65 |
| `.layers` | `left:88px; bottom:34px; 79×79` |
| `.watermark` | `bottom:9px; left:calc(72px + (100vw - 72px)/2); transform:translateX(-50%)` |
| Toast | `bottom:28px`, horizontally centred on the viewport |
| Google map logo / attribution bar | Rendered by the map at its bottom edge. Nothing of ours may cover it (Layers tile bottom 34px and map controls bottom 40px already clear it). |

### 4.2 Desktop (≥1024) — panel open (`body.panel-open`)

| Element | Change |
|---|---|
| `.panel` | `left:0; top:0; bottom:0; width:488px` (= 72 + 408 + 8); `padding:8px 8px 8px 72px`; background `--cs-rail`. The rail (z 50) sits over its left 72px. |
| `.panel-card` | Fills the padding box: x 72→480, y 8→(100vh−8); radius 24px; white; `overflow:hidden` |
| `#mapwrap` | `left:488px` (call `google.maps.event.trigger(map,'resize')` 320ms after the change) |
| `.search` | Unchanged — it floats over the top of the panel card (over the hero photo), ending at x 480 = card's right edge, exactly like Maps |
| `.chips` | `left:508px` |
| `.collapse-tab` | Outside the card at `left:100%` of `.panel` (x 488), `top:50%; margin-top:-24px; 23×48`; radius `0 8px 8px 0`; bg `--cs-rail` |
| `.layers` | `left:512px` |
| `.watermark` | `left:calc(488px + (100vw - 488px)/2)` |
| `.area`, `.herocard` | Hidden |
| Collapsed panel (collapse tab pressed) | Panel hidden, map `left:72px`, collapse tab stays at `left:72px` with icon `arrow_right` ("Expand side panel"); selection and the rail place entry are kept |

### 4.3 Tablet (768–1023) — overrides on top of desktop

| Element | Change |
|---|---|
| `.topright` | `right:16px`. DEMO chip shows the short label `DEMO · simulated`. Wallet pill becomes a 40×40 circle (icon only, `aria-label="Connect wallet"`, tooltip) |
| `.chips` | Second row: `top:68px; left:88px` (panel open `left:504px`); `right:16px; height:40px; gap:8px`; horizontal scroll (`overflow-x:auto; scrollbar-width:none`), **no** mask, **no** `.chips-next` |
| `.area`, `.herocard` | `top:116px` |
| `.mapctl` | `right:12px` |
| Panel | Same 408px side panel; map gets the remaining width (≥ 280px) |

### 4.4 Mobile (<768)
```
┌─────────────────────────────────┐ safe-top
│ [▣ Search shops or paste a link 🚀 ◉] │ top: safe+10, left/right 12, h48
│ [🔥 Live coins][Cafés][Barbers]… →    │ top: safe+68, h40 (scrolls)
│ (● DEMO · simulated)          (◇) │ DEMO top: safe+116 left 12 · Layers FAB top: safe+112 right 12
│                                 │
│              MAP                │
│                           (◎)   │ Locate FAB: bottom = sheet-h + 40 (24 when no sheet)
├──────────────═══────────────────┤ ← sheet top (peek 148px / half 52dvh / full 100dvh−72px)
│ Bosphorus Grill        (⇪) (✕)  │
│ …                               │
└─────────────────────────────────┘
```

| Element | Position / size |
|---|---|
| `#mapwrap` | `left:0; right:0; top:0`; `bottom:var(--sheet-h)` when a sheet is open, `bottom:0` when nothing is open, `bottom:calc(100dvh - 330px)` while the hero sheet is shown |
| `.search` | `left:12px; right:12px; top:calc(env(safe-area-inset-top) + 10px)`; box 48px, `padding-left:6px` |
| `.chips` | `left:0; right:0; top:calc(env(safe-area-inset-top) + 68px); height:40px; padding:0 12px; gap:8px`; horizontal scroll, hidden scrollbar, no mask |
| `.m-demo` (DEMO chip) | `left:12px; top:calc(env(safe-area-inset-top) + 116px); height:28px; padding:0 10px 0 8px; font-size:11px` |
| Layers FAB | `right:12px; top:calc(env(safe-area-inset-top) + 112px); 44×44` white circle, `--cs-elev-2` |
| Locate FAB | `right:12px; bottom:calc(var(--sheet-h) + 40px)`; `bottom:24px` when nothing is open; hidden while hero is shown |
| `.panel` (bottom sheet) | `left:0; right:0; bottom:0; height:var(--sheet-h)`; z `--z-sheet`; card radius `28px 28px 0 0`; `--cs-elev-sheet` |
| Hidden on mobile | `.rail`, `.topright`, `.area`, `.layers` tile, `.watermark`, `.chips-next`, `.collapse-tab`, `.mapctl` (pinch to zoom), desktop hero photo, desktop `.actions`, `.fees` card, `.coin` section (their content moves to the `.strip` and the Coin tab) |
| Toast | `bottom:calc(var(--sheet-h) + 12px)` (24px + safe-bottom when no sheet) |
| Safe areas | `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`. Sheet scroll content ends with `padding-bottom:calc(16px + env(safe-area-inset-bottom))` |
| Width floor | Must be perfect at 375px and usable at 320px (search input min 120px; chips scroll) |

### 4.5 Map viewport rules
- Desktop: selecting a pin pans it into the visible map area (right of the panel) only if it is outside the inner 80% of that area; otherwise the map does not move.
- Mobile: selecting a pin pans so the pin sits at 40% of the visible map height (above the sheet). The mock does this with `center = {lat: pin.lat + 0.0011, lng: pin.lng + 0.0012}` at zoom 15; the app must compute it from projection, not constants.
- Initial view: last viewport (sessionStorage, try/catch) → else Dalston demo cluster `{lat:51.5469,lng:-0.0712}` zoom 15 (hero state `{lat:51.5468,lng:-0.0745}`). Never auto-request geolocation.

## 5. Z-index layers

Use the tokens only; never a raw z-index number in component CSS (except inside a component's own stacking context, listed at the bottom).

| Token | Value | Contents |
|---|---|---|
| `--z-map` | 0 | `#mapwrap` (Google map; coin pins live inside the map's own panes) |
| `--z-pins` | 10 | Reserved for a non-Google fallback pin layer (MapLibre markers container) |
| `--z-map-ctrl` | 20 | `.mapctl` (locate/zoom), `.layers` tile, `.watermark`, mobile FABs |
| `--z-float` | 30 | `.chips`, `.chips-next`, `.topright` (DEMO + wallet), `.area`, desktop `.herocard`, mobile `.m-demo`, Layers popover |
| `--z-panel` | 40 | Desktop `.panel` (side panel) incl. collapse tab |
| `--z-rail` | 50 | `.rail` (sits above the panel's left 72px) |
| `--z-search` | 60 | `.search` incl. its suggestions dropdown, wallet account menu |
| `--z-sheet` | 70 | Mobile bottom sheet `.panel`, mobile hero sheet |
| `--z-scrim` | 90 | `.scrim` behind modals and the mobile drawer |
| `--z-modal` | 100 | `.dialog` (launch, claim, wallet, share), mobile drawer |
| `--z-toast` | 110 | `.toast` stack |
| `--z-tooltip` | 120 | Tooltips |

Local stacking (inside one component, raw numbers allowed):
- Pins: inside `overlayMouseTarget` pane; the **selected** pin is moved to the map's `floatPane` (research/google.md §3) and also gets `z-index:5`.
- Panel internals: `.tabs` is `position:sticky; top:0; z-index:2`; `.handle` z 3; mobile `.ph-x` (share/close) z 4; hero "Coin art" button and credit z 1.
- Mobile: the search pill (60) is *below* a full-height sheet (70). The sheet's full snap stops at `top:72px`, so the search pill stays visible above it.

## 6. Map chrome components

Shared button CSS (from the mock, verbatim — used by every component below):
```css
.btn{height:40px;padding:0 20px;border-radius:20px;font-size:14px;line-height:20px;font-weight:600;letter-spacing:.1px;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap;transition:background var(--cs-dur-2) var(--cs-ease),box-shadow var(--cs-dur-2) var(--cs-ease)}
.btn .ms{font-size:18px;margin-left:-4px}
.btn-primary{background:var(--cs-green);color:#fff}
.btn-primary:hover{background:var(--cs-green-hover);box-shadow:var(--cs-elev-1)}
.btn-tonal{background:var(--cs-green-container);color:var(--cs-on-green-container)}
.btn-outline{border:1px solid var(--cs-outline-2);background:#fff;color:var(--cs-text)}
.btn-outline .ms{color:var(--cs-green)}
.btn-amber{background:var(--cs-on-amber-container);color:#fff}
.btn-amber:hover{background:#563000}
.btn-text{height:40px;padding:0 12px;color:var(--cs-green);font-weight:600}
.btn-block{width:100%;height:48px;border-radius:24px;font-size:15px}
.icon-btn{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;color:var(--cs-icon)}
.icon-btn:hover{background:var(--cs-state-hover)}
```
Added states (not in the mock, apply to all `.btn`, `.icon-btn`, `.chip`, `.act`):
- `:active` → `.btn-primary` bg `--cs-green-press`; others overlay `--cs-state-press`.
- `[disabled]`, `[aria-disabled="true"]` → `opacity:.38; cursor:default; box-shadow:none`, no hover change.
- Loading → label stays, a 18px `progress_activity` icon replaces the leading icon and spins (`rotate` 1s linear infinite), `aria-busy="true"`, clicks ignored.
- `.btn-outline:hover` → bg `--cs-state-hover`. `.btn-tonal:hover` → `--cs-elev-1`.

### 6.1 Left rail (desktop/tablet)
```css
.rail{position:fixed;left:0;top:0;bottom:0;width:var(--rail-w);background:var(--cs-rail);z-index:var(--z-rail);display:flex;flex-direction:column;align-items:center;padding:16px 0 12px}
.app-icon{width:40px;height:40px;border-radius:12px;background:var(--cs-green);display:grid;place-items:center;box-shadow:0 1px 2px rgba(14,124,71,.35)}
.app-icon svg{width:24px;height:24px}
.rail-list{list-style:none;margin:0;padding:0;width:100%}
.rail-item{display:flex;flex-direction:column;align-items:center;width:100%;height:64px;margin-top:16px;padding-top:8px;color:var(--cs-text-2)}
.rail-item .ind{position:relative;width:48px;height:32px;border-radius:16px;display:grid;place-items:center;transition:background var(--cs-dur-2) var(--cs-ease)}
.rail-item:hover .ind{background:var(--cs-state-hover)}
.rail-item .ms{color:var(--cs-icon)}
.rail-item .lbl{margin-top:4px;font-size:12px;line-height:16px;font-weight:500;letter-spacing:.2px;max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail-item.active .ind{background:var(--cs-green-container)}
.rail-item.active .ms{color:var(--cs-on-green-container);font-variation-settings:'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24}
.rail-item.active .lbl{color:var(--cs-on-green-container);font-weight:600}
.badge{position:absolute;top:-2px;left:28px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--cs-green);color:#fff;font-size:11px;line-height:14px;font-weight:700;border:2px solid var(--cs-rail);display:grid;place-items:center;font-variant-numeric:tabular-nums}
.badge.amber{background:var(--cs-amber-bright);color:#3d2200}
.live-dot{position:absolute;top:2px;left:31px;width:10px;height:10px;border-radius:50%;background:var(--cs-green-bright);border:2px solid var(--cs-rail)}
.live-dot::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid var(--cs-green-bright);animation:ping 1.6s var(--cs-ease-decel) infinite}
@keyframes ping{0%{transform:scale(.6);opacity:.9}100%{transform:scale(2.2);opacity:0}}
.rail-sep{width:40px;height:1px;background:var(--cs-outline-2);margin:16px 0 0}
.rail-place{display:flex;flex-direction:column;align-items:center;margin-top:12px;width:100%}
.rail-place .thumb{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:22px;box-shadow:inset 0 0 0 2px var(--cs-green)}
.rail-place .thumb.dashed{box-shadow:none;border:2px dashed var(--cs-green)}
.rail-place .lbl{margin-top:4px;font-size:12px;line-height:16px;font-weight:600;color:var(--cs-on-green-container);max-width:66px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail-spacer{flex:1}
```
**Structure (top → bottom):** app icon (40×40, white map-pin glyph, links home) · Live (`bolt` + `.live-dot`) · Top shops (`leaderboard`) · Launched (`rocket_launch` + `.badge` count) · My coins (`account_balance_wallet`) · `.rail-sep` + `.rail-place` (only while a place is selected) · spacer · Help (`help`, item height 56px).

App icon SVG (also favicon, search logo, hero brand; never altered):
```html
<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c-3.9 0-7 3-7 6.9C5 14.6 12 21.5 12 21.5s7-6.9 7-12.1c0-3.9-3.1-6.9-7-6.9z" fill="#fff"/><circle cx="12" cy="9.4" r="3.6" fill="#0e7c47"/></svg>
```

| State | Visual |
|---|---|
| Default | Icon `--cs-icon`, label `--cs-text-2` 500 |
| Hover | Indicator 48×32 fills `--cs-state-hover` |
| Active (its panel is open) | Indicator `--cs-green-container`, icon FILL 1 `--cs-on-green-container`, label 600 `--cs-on-green-container`. Exactly one or zero items active. |
| Live dot | Always on while the live feed socket/simulator is running; static (no ping) when `prefers-reduced-motion` or when the feed is paused/offline (dot turns `--cs-text-3`) |
| Badge (Launched) | Count of launches since the user last opened Launched (localStorage `cs_launched_seen_at`, try/catch). Hidden at 0, `99+` above 99. `.badge.amber` variant is used on **My coins** when the connected wallet owns a claimed shop with fees available |
| Rail place – launched | `.thumb` = coin emoji (22px) on the coin's `--bg`, inset 2px green ring; label `$TICKER` |
| Rail place – launchable | `.thumb.dashed` white, `rocket_launch` FILL 22px green; label `New coin` |
| Rail place – hidden | No place selected, or a rail panel (Live/Top shops/Launched/My coins) is showing |

### 6.2 Search pill + suggestions
```css
.search{position:fixed;left:88px;top:12px;width:var(--search-w);z-index:var(--z-search)}
.search-box{height:var(--search-h);border-radius:24px;background:#fff;box-shadow:var(--cs-elev-search);display:flex;align-items:center;padding:0 0 0 24px;position:relative}
.search.open .search-box{border-radius:24px 24px 0 0;box-shadow:0 2px 4px rgba(0,0,0,.2)}
.search-logo{display:none}
.search input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:15px;line-height:24px;letter-spacing:.1px;color:var(--cs-text);padding:0}
.search input::placeholder{color:var(--cs-text-2);font-size:14px;opacity:1}
.search .sbtn{width:48px;height:48px;display:grid;place-items:center;color:var(--cs-icon);border-radius:24px}
.search .sbtn:hover{background:var(--cs-state-hover)}
.search .sbtn.launch{color:var(--cs-green);margin-right:4px}
.search .sbtn.launch .ms{font-variation-settings:'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 24}
.search .sbtn-sep{width:1px;height:24px;background:var(--cs-outline-2)}
.search .wallet-mini{display:none}
.sugg{display:none;background:#fff;border-radius:0 0 16px 16px;box-shadow:0 2px 4px rgba(0,0,0,.2);padding:0 0 8px;border-top:1px solid var(--cs-divider)}
.search.open .sugg{display:block}
.sugg-h{padding:12px 24px 4px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--cs-text-3)}
.srow{display:flex;align-items:center;height:46px;padding:0 16px 0 18px;gap:15px;font-size:14px;line-height:20px;cursor:pointer}
.srow:hover,.srow.hl{background:var(--cs-surface-2)}
.srow .ms{color:var(--cs-icon);font-size:21px;width:28px;text-align:center}
.srow .av{width:28px;height:28px;font-size:16px}  /* + display:grid;place-items:center;border-radius:50%;background:<coin bg> */
.srow .tx{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.srow .tx b{font-weight:600}
.srow .tx span{color:var(--cs-text-2)}
.srow .rt{font-size:12px;font-weight:600}
.srow.link{height:56px;background:var(--cs-green-tint)}
.srow.link .ms{color:var(--cs-green)}
.srow.link .tx small{display:block;font-size:12px;line-height:16px;color:var(--cs-text-2)}
/* mobile (<768) */
.search{left:12px;right:12px;top:calc(env(safe-area-inset-top) + 10px);width:auto}
.search-box{padding-left:6px;height:48px}
.search-logo{display:grid;width:36px;height:36px;border-radius:12px;background:var(--cs-green);place-items:center;margin-right:10px;flex:none}
.search-logo svg{width:22px;height:22px}
.search input{font-size:16px} .search input::placeholder{font-size:15px}
.search .sbtn.find,.search .sbtn-sep{display:none}
.search .sbtn.launch{width:40px;height:40px;margin-right:0}
.search .wallet-mini{display:grid;width:36px;height:36px;border-radius:50%;background:var(--cs-green-container);color:var(--cs-on-green-container);place-items:center;margin:0 6px 0 2px}
.search .wallet-mini .ms{font-size:20px}
```
**Box contents:** desktop `[input][search 48][sep][rocket_launch 48, green, FILL]`; mobile `[app-icon logo 36][input][rocket_launch 40][wallet-mini 36]`. Placeholder: desktop `Search shops or paste a Google Maps link`, mobile `Search shops or paste a link`.

**Dropdown order** (only sections with results render; max 8 rows total):
1. **Link row** (`.srow.link`, 56px, `--cs-green-tint`) — shown when the input matches a Google Maps URL (`maps.app.goo.gl/`, `goo.gl/maps/`, `google.<tld>/maps`, `maps.google.<tld>`). Icon `link` green. Title `Google Maps link detected`; sub `maps.app.goo.gl/… · tap to open this place` (show the actual host). Trailing small `.btn-primary` 32h, `padding:0 14px; font-size:13px`, label `Launch`. States: resolving → sub `Finding this place…` + trailing button shows spinner; resolved → sub becomes `<place name from Google> · <short address>` (display only, not stored); already launched → trailing button reads `View $TICKER` (`.btn-tonal`); failed → icon `error` `--cs-down`, title `Couldn't read that link`, sub `Try the full google.com/maps link`, no button.
2. **`Coins`** overline + up to 3 coin rows: `.av` (coin emoji on coin bg) · `<b>$TICKER</b> <span>· Coin name</span>` · `.rt` change (`.up`/`.down`, `▲ 12.4%`). Matches ticker or coin name (our data only).
3. **`Places`** overline + up to 5 Google autocomplete rows (`AutocompleteSuggestion.fetchAutocompleteSuggestions`, session token): icon `location_on` · `.tx` = prediction main text with the matched substring in `<b>` and secondary text in `<span>` · trailing `.rt` `Launch` in `--cs-green` when no coin exists for that place ID, or the coin's `$TICKER` in `--cs-on-green-container` when one does. A query-row `<b>Kebab</b> shops near Dalston <span>· 14 places</span>` is shown first when the query looks like a category (matches a chip category).
4. **Google credit row** (mobile only, when the dropdown covers the map's Google logo): 32px row, right-aligned text `Google Maps` 12px 400 `#5e5e5e`, `translate="no"`, no wrapping. Desktop does not need it (the map's own logo stays visible).

| State | Visual |
|---|---|
| Idle | Pill radius 24, `--cs-elev-search` |
| Focused, empty input | `.open`: radius `24 24 0 0`; dropdown shows `Recent` overline + last 5 opened coins/places (localStorage `cs_recent`, place IDs and coin IDs only, try/catch), then a tip row: icon `link`, `Paste a Google Maps link to launch any shop` |
| Typing | 150ms debounce; results replace in place. While loading the Places section shows 2 skeleton rows (§13.3) |
| Keyboard highlight | `.srow.hl` bg `--cs-surface-2`; ↑/↓ move, Enter activates, Esc closes and blurs |
| No results | Single row: icon `search_off`, `No shops match "<q>"`, sub `Paste a Google Maps link instead`, no action |
| Offline / Places error | Row: icon `wifi_off`, `Search is unavailable right now`; Coins section still works |
| Mobile focus | Dropdown fills to `bottom:0` (white, scrolls), chips/DEMO/FABs hidden underneath; a leading `arrow_back` (40×40) replaces the app-icon logo and closes search |

### 6.3 Chips row
```css
.chips{position:fixed;left:529px;top:13px;height:48px;right:396px;z-index:var(--z-float);display:flex;align-items:center;gap:6px;overflow:hidden;-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 64px),transparent calc(100% - 20px));mask-image:linear-gradient(90deg,#000 calc(100% - 64px),transparent calc(100% - 20px));padding-left:4px}
body.panel-open .chips{left:508px}
.chip{flex:none;height:32px;padding:0 12px 0 10px;border-radius:16px;background:#fff;box-shadow:var(--cs-elev-1);display:inline-flex;align-items:center;gap:6px;font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px;color:var(--cs-text);white-space:nowrap;transition:background var(--cs-dur-2) var(--cs-ease)}
.chip:hover{background:#f5f7f6}
.chip .ms{font-size:18px;color:var(--cs-text)}
.chip .em{font-size:15px;line-height:1}
.chip.on{background:var(--cs-green-container);color:var(--cs-on-green-container)}
.chip.on .ms{color:var(--cs-on-green-container)}
.chip.fees .n{color:var(--cs-amber);font-weight:700}
.chips-next{position:fixed;top:21px;width:32px;height:32px;border-radius:50%;background:#fff;box-shadow:var(--cs-elev-1);display:grid;place-items:center;z-index:var(--z-float);right:400px;color:var(--cs-icon)}
/* mobile */
.chips,body.panel-open .chips{left:0;right:0;top:calc(env(safe-area-inset-top) + 68px);height:40px;padding:0 12px;gap:8px;overflow-x:auto;-webkit-mask-image:none;mask-image:none;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
```
Chips, in order (`role="toolbar" aria-label="Filters"`, each chip `aria-pressed`):

| # | Leading | Label | Filter (coin pins only; Google POIs stay visible and clickable) |
|---|---|---|---|
| 1 | emoji 🔥 | `Live coins` | Coins with ≥1 trade in the last 60 min |
| 2 | `local_cafe` | `Cafés` | Coin category = Café |
| 3 | `content_cut` | `Barbers` | Barber shop |
| 4 | `kebab_dining` | `Kebab` | Kebab shop |
| 5 | `local_pizza` | `Pizza` | Pizza |
| 6 | `bakery_dining` | `Bakeries` | Bakery |
| 7 | `sports_bar` | `Pubs` | Pub |
| 8 | `storefront` | `Corner shops` | Corner shop |
| 9 | emoji 💰 | `Fees waiting` + `<span class="n">$1.2k</span>` | Unclaimed coins with fees > $0; `.n` = sum of unclaimed fees in view, compact USD |

States: default white `--cs-elev-1`; hover `#f5f7f6`; **on** `--cs-green-container` / `--cs-on-green-container` (and a trailing `close` 16px icon appears inside the chip, meaning "tap again to clear"). Single-select: turning one on turns the others off. With a filter on, non-matching coin pins are hidden and the "This area" card counts only matches. `.chips-next` (desktop only) is shown only when the row overflows; it hides when scrolled to the end.

### 6.4 Top-right: DEMO chip + Connect wallet pill
```css
.topright{position:fixed;right:28px;top:12px;height:40px;display:flex;align-items:center;gap:12px;z-index:var(--z-float)}
.demo-chip{height:32px;padding:0 12px 0 10px;border-radius:16px;background:var(--cs-amber-container);color:var(--cs-on-amber-container);display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.3px;box-shadow:var(--cs-elev-1);white-space:nowrap}
.demo-chip i{width:8px;height:8px;border-radius:50%;background:var(--cs-amber-bright);box-shadow:0 0 0 3px rgba(245,158,11,.25)}
.demo-chip span{font-weight:500;letter-spacing:.1px}
.wallet-btn{height:40px;padding:0 18px 0 14px;border-radius:20px;background:var(--cs-green);color:#fff;display:inline-flex;align-items:center;gap:8px;font-size:14px;line-height:20px;font-weight:600;letter-spacing:.1px;box-shadow:var(--cs-elev-1)}
.wallet-btn .ms{font-size:20px}
.wallet-btn:hover{background:var(--cs-green-hover)}
```
**DEMO chip** — `<i>` dot + `DEMO` + `<span> · simulated prices</span>` (desktop) / `<span> · simulated</span>` (tablet, mobile). It is a `<button>` (not a div as in the mock) so it can open the explainer (§18). Always visible in the prototype; it is never dismissible.

**Wallet pill states**

| State | Visual |
|---|---|
| Disconnected | `.wallet-btn` green: `account_balance_wallet` + `Connect wallet` |
| Connecting | Same pill, label `Connecting…`, spinner replaces icon, `aria-busy` |
| Connected | White pill 40h, `padding:0 10px 0 6px`, `--cs-elev-1`, gap 8: 28px wallet icon (from Wallet Standard `wallet.icon`, radius 8) or 28px gradient blob for email accounts · short address `7xKX…3pQa` 14/20 600 mono-free (Roboto Flex tabular) · `expand_more` 20px `--cs-icon`. Hover bg `--cs-chip-hover` |
| Account menu open | 280px white card under the pill (`top:56px; right:28px`), radius 16, `--cs-elev-2`, padding 8 0, z `--z-search`. Header (16px padding): blob/icon 40 + full short address + `Copy` icon button (`content_copy`) + balance line `2.41 SOL · $361` (demo). Rows (48px, icon 20 + 14/20 label): `account_balance_wallet My coins`, `open_in_new View on Solscan`, `logout Disconnect` |
| Mobile `.wallet-mini` | 36px green-container circle with `account_balance_wallet`; connected: shows the 28px wallet icon / blob inside a 36px circle with a 2px `--cs-green` ring |

### 6.5 "This area" card
```css
.area{position:fixed;left:88px;top:72px;width:var(--search-w);background:#fff;border-radius:var(--cs-r-lg);box-shadow:var(--cs-elev-1);z-index:var(--z-float);overflow:hidden}
body.panel-open .area,body.hero-on .area{display:none}
body.live-on .area{display:none}
.area-h{display:flex;align-items:center;justify-content:space-between;padding:10px 20px 0;height:40px}
.area-h h2{margin:0;font-size:16px;line-height:20px;font-weight:600}
.area-live{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--cs-text-2);letter-spacing:.2px}
.area-live i{position:relative;width:8px;height:8px;border-radius:50%;background:var(--cs-green-bright)}
.area-live i::after{content:"";position:absolute;inset:-2px;border-radius:50%;border:2px solid var(--cs-green-bright);animation:ping 1.6s var(--cs-ease-decel) infinite}
.area-row{display:flex;align-items:center;width:100%;min-height:56px;padding:6px 16px 8px 16px;gap:16px;text-align:left}
.area-row:hover{background:var(--cs-state-hover)}
.area-ic{width:32px;height:32px;border-radius:50%;background:var(--cs-amber-container);display:grid;place-items:center;color:var(--cs-amber);flex:none}
.area-ic .ms{font-size:18px}
.area-row .tx{flex:1;min-width:0}
.area-row .t1{font-size:16px;line-height:24px;letter-spacing:.1px}
.area-row .t2{font-size:12px;line-height:16px;letter-spacing:.2px;color:var(--cs-text-2)}
.area-row .t2 b{color:var(--cs-amber);font-weight:700}
.area-row > .ms{color:var(--cs-icon)}
```
Content: `This area` + live indicator `3 trading now` · row: amber `payments` (FILL) icon · `7 shops have coins` / `<b>$1.2k</b> waiting for owners` · `chevron_right`. Values are computed from coins inside the current map bounds (recomputed on `idle`, 300ms debounce). Visible only on desktop/tablet when: no panel open, no hero, no rail panel.

| State | Content |
|---|---|
| Coins in view, fees > 0 | As above |
| Coins in view, fees = 0 | t2 `No fees waiting yet` (no `<b>`) |
| No coins in view | Icon becomes `rocket_launch` on `--cs-green-container`; t1 `No coins here yet`; t2 `Tap any shop on the map to launch one`; live indicator hidden |
| Zoomed out (< 11) | t1 `Zoom in to see shops`; row not clickable (no chevron) |
| Nobody trading | Live indicator text `quiet right now`, dot `--cs-text-3`, no ping |

### 6.6 Map controls (desktop/tablet) and FABs (mobile)
```css
.mapctl{position:fixed;right:20px;bottom:40px;z-index:var(--z-map-ctrl);display:flex;flex-direction:column;align-items:center;gap:8px}
.ctl{width:32px;height:32px;background:#fff;display:grid;place-items:center;color:var(--cs-text);border-radius:8px;box-shadow:var(--cs-elev-1)}
.ctl:hover{background:#f5f5f5}
.ctl .ms{font-size:20px}
.ctl.locate .ms{color:var(--cs-icon)}
.zoom{display:flex;flex-direction:column;border-radius:8px;box-shadow:var(--cs-elev-ctrl);background:#fff;overflow:hidden}
.zoom .ctl{box-shadow:none;border-radius:0}
.zoom hr{margin:0 6px;border:0;height:1px;background:var(--cs-divider)}
.m-fab{position:fixed;right:12px;z-index:var(--z-map-ctrl);width:44px;height:44px;border-radius:50%;background:#fff;box-shadow:var(--cs-elev-2);display:grid;place-items:center;color:var(--cs-icon)}
```
Controls: Locate (`my_location`, "Near me") · Zoom in (`add`) · Zoom out (`remove`). The map is created with `disableDefaultUI:true`, so these are the only controls.

| Locate state | Icon / colour |
|---|---|
| Idle | `my_location` `--cs-icon` |
| Locating | `progress_activity` spinning, `--cs-icon` |
| Located (map centred on user) | `my_location` FILL, `--cs-loc` |
| Map moved away after locating | Back to idle icon, user dot stays |
| Denied / unavailable | Icon stays idle; toast (§13.1) |

Zoom buttons get `disabled` at the map's min/max zoom.

### 6.7 Layers tile + Layers popover
```css
.layers{position:fixed;left:88px;bottom:34px;width:79px;height:79px;border-radius:8px;border:2px solid #fff;box-shadow:var(--cs-elev-1);z-index:var(--z-map-ctrl);overflow:hidden;background:#eef3ef}
body.panel-open .layers{left:512px}
.layers .mini{position:absolute;inset:0;background:
  radial-gradient(circle at 30% 38%,rgba(21,163,90,.95) 0 4px,transparent 5px),
  radial-gradient(circle at 64% 30%,rgba(21,163,90,.95) 0 3px,transparent 4px),
  radial-gradient(circle at 52% 58%,rgba(245,158,11,.95) 0 4px,transparent 5px),
  radial-gradient(circle at 76% 62%,rgba(21,163,90,.95) 0 3px,transparent 4px),
  radial-gradient(circle at 40% 45%,rgba(21,163,90,.25) 0 16px,transparent 26px),
  linear-gradient(115deg,transparent 46%,#fff 46% 52%,transparent 52%),
  linear-gradient(20deg,transparent 60%,#fff 60% 65%,transparent 65%),
  linear-gradient(160deg,#e9efe9,#dfe8e1)}
.layers .lab{position:absolute;inset:auto 0 0 0;height:28px;background:linear-gradient(transparent,rgba(0,0,0,.55));color:#fff;display:flex;align-items:center;gap:4px;padding:6px 6px 0;font-size:11px;line-height:13px}
.layers .lab .ms{font-size:16px}
```
**Layers popover (new):** opens to the right of the tile (`left: tile.right + 8px; bottom:34px`), width 296px, white, radius 16, `--cs-elev-2`, padding 16, z `--z-float`. Mobile: opens as a bottom sheet (half snap) from the Layers FAB.
- Section `Map type` (overline): two 72×72 radio tiles side by side (radius 8, 2px border `--cs-outline-2`; selected 2px `--cs-green` + label 600 green): `Default` (`roadmap`) and `Satellite` (`hybrid`). Label under tile 12/16.
- Section `On the map` (overline): toggle rows 48px (label 14/20 + 36×20 switch; on = `--cs-green` track, white 16px thumb): `Coins` (on), `Fees waiting dots` (on), `Live trade flashes` (on), `Owner-verified ticks` (on).
- Settings persist in localStorage `cs_layers` (try/catch). Close: click outside, Esc, or the tile again.

### 6.8 Watermark & attribution
```css
.watermark{position:fixed;bottom:9px;left:calc(var(--rail-w) + (100vw - var(--rail-w)) / 2);transform:translateX(-50%);z-index:var(--z-map-ctrl);font-size:15px;line-height:20px;font-weight:800;font-stretch:118%;letter-spacing:.4px;color:#6b6f73;pointer-events:none;text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff,0 0 4px #fff;display:flex;align-items:center;gap:5px}
.watermark svg{width:14px;height:14px}
body.panel-open .watermark{left:calc(488px + (100vw - 488px) / 2)}
```
Watermark = inverted pin glyph (green pin, white dot) + `CORNERSHOP`; `aria-hidden`, non-interactive, desktop/tablet only. Google's map logo, "Keyboard shortcuts", "Map data ©", "Terms" and "Report a map error" are rendered by the Maps JS API and must stay visible and unobstructed at every breakpoint and sheet height. On mobile the sheet sits *below* the map (the map's `bottom` = sheet height), so Google's logo stays above the sheet.

### 6.9 Mobile navigation drawer (new; replaces the rail on <768)
Opened by tapping the green app-icon logo inside the mobile search pill. Left drawer `width:var(--drawer-w)`, full height, white, radius `0 16px 16px 0`, `--cs-elev-3`, z `--z-modal`, over `.scrim`.
- Header 64px, padding 0 16: app icon 32 (radius 10) + wordmark `CORNERSHOP` (16/20 800 stretch 120%).
- Items 56px, padding 0 16, gap 16, icon 24 + label 16/24 500, active item = 56px pill radius 28 `--cs-green-container` with FILL icon: `Live` (with live dot), `Top shops`, `Launched` (+ badge right-aligned), `My coins`, divider, `Help`, `About CORNERSHOP`.
- Footer: DEMO chip (full label) and `Business opt-out` text link 12/16.

## 7. Map layer: coin pins & location

All coin pins are custom HTML inside **one** `google.maps.OverlayView` (raster map, no `mapId`). Clickable pins go in `getPanes().overlayMouseTarget`; the selected pin goes in `floatPane`. Call `OverlayView.preventMapHitsAndGesturesFrom(rootEl)` so a pin click never also fires a map/POI click. Position with `fromLatLngToDivPixel()` and cull pins outside the bounds + 64px.

### 7.1 Pin CSS (from the mock, verbatim)
```css
.pin{position:absolute;width:0;height:0;cursor:pointer}
.pin .mk{position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;background:var(--bg,#fff);box-shadow:0 0 0 2px #fff,0 1px 3px 1px rgba(0,0,0,.28);display:grid;place-items:center;font-size:16px;line-height:1;transition:transform var(--cs-dur-2) var(--cs-ease)}
.pin .mk::before{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid var(--cs-green-bright);opacity:.9}
.pin:hover .mk{transform:scale(1.12)}
.pin .lb{position:absolute;left:21px;top:-17px;white-space:nowrap;pointer-events:none;text-shadow:-1.5px -1.5px 0 #fff,1.5px -1.5px 0 #fff,-1.5px 1.5px 0 #fff,1.5px 1.5px 0 #fff,0 -1.5px 0 #fff,0 1.5px 0 #fff,-1.5px 0 0 #fff,1.5px 0 0 #fff,0 0 4px #fff}
.pin .lb b{display:block;font-size:13.5px;line-height:17px;font-weight:750;color:var(--cs-green);letter-spacing:.1px}
.pin .lb small{display:block;font-size:11px;line-height:14px;font-weight:600;color:var(--cs-text-2);font-variant-numeric:tabular-nums}
.pin.left .lb{left:auto;right:21px;text-align:right}
.pin .fee-dot{position:absolute;left:7px;top:-19px;width:12px;height:12px;border-radius:50%;background:var(--cs-amber-bright);box-shadow:0 0 0 2px #fff}
.pin .vtick{position:absolute;left:5px;top:3px;width:15px;height:15px;border-radius:50%;background:var(--cs-green);box-shadow:0 0 0 2px #fff;display:grid;place-items:center;color:#fff}
.pin .vtick .ms{font-size:12px;font-variation-settings:'FILL' 1,'wght' 700,'GRAD' 0,'opsz' 20}
.pin.flash .mk::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:3px solid var(--cs-green-bright);animation:flash 1.4s var(--cs-ease-decel) infinite}
.pin.flash.sell .mk::after{border-color:var(--cs-down)}
@keyframes flash{0%{transform:scale(1);opacity:1}100%{transform:scale(2.3);opacity:0}}
.pin .tag{position:absolute;left:21px;top:16px;height:18px;padding:0 6px;border-radius:9px;background:var(--cs-green);color:#fff;font-size:10.5px;line-height:18px;font-weight:700;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.pin.flash.sell .tag{background:var(--cs-down)}
.pin.sel{z-index:5}
.pin.sel .mk{display:none}
.pin .balloon{display:none}
.pin.sel .balloon{display:block;position:absolute;left:-20px;top:-54px;width:40px;height:54px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3))}
.pin .bsvg{position:absolute;inset:0;width:100%;height:100%}
.pin.sel .balloon .face{position:absolute;left:6px;top:6px;width:28px;height:28px;border-radius:50%;background:var(--bg,#fff);display:grid;place-items:center;font-size:16px}
.pin.sel .lb{left:24px;top:-46px}
.pin.sel .lb b{font-size:15px;line-height:19px}
.pin.sel .lb small{font-size:12px}
.pin.launchable .balloon .face{background:#fff;color:var(--cs-green)}
.pin.launchable .balloon .face .ms{font-size:20px;font-variation-settings:'FILL' 1,'wght' 500,'GRAD' 0,'opsz' 20}
body.lowzoom .pin:not(.sel) .mk{left:-6px;top:-6px;width:12px;height:12px;font-size:0;background:var(--cs-green-bright)}
body.lowzoom .pin:not(.sel) .mk::before,body.lowzoom .pin:not(.sel) .lb,body.lowzoom .pin:not(.sel) .vtick,body.lowzoom .pin:not(.sel) .fee-dot,body.lowzoom .pin:not(.sel) .tag{display:none}
```
Balloon SVG (`viewBox="0 0 40 54"`, path `M20 1C9.5 1 1 9.3 1 19.6 1 33.5 20 53 20 53s19-19.5 19-33.4C39 9.3 30.5 1 20 1z`):
- Coin: `fill="#0e7c47" stroke="#0b6b3d" stroke-width="1"`.
- Launchable: `fill="#fff" stroke="#0e7c47" stroke-width="2.5" stroke-dasharray="4 3"`.

### 7.2 Pin anatomy & states
The pin's anchor (0×0) is the place's lat/lng. The marker is a 30px circle showing the coin's sticker emoji (16px) on the coin's pastel `--bg` (chosen at launch, §12.2), with a 2px white ring and a 2px `--cs-green-bright` outer ring. The label sits to the right: `$TICKER` (green, 750) over `▲12% · $212k` (the change is coloured `.up`/`.down`, followed by ` · ` and the market cap in `--cs-text-2`).

| State | Trigger | Visual |
|---|---|---|
| **Dot (low zoom)** | `map.getZoom() < 14` → `body.lowzoom` | 12×12 `--cs-green-bright` circle, white 2px ring; no emoji, label, tick, fee dot or tag. The selected pin keeps its balloon |
| **Label pin** (default) | zoom ≥ 14 | Marker + label as above |
| **Label left** | Label would collide with a higher-mcap pin's label or leave the visible map | `.pin.left`: label (and tag) right-aligned at `right:21px` |
| **Label hidden** | Still colliding after flipping | Marker only; label shows on hover/focus. Priority: selected > higher mcap |
| **Hover / focus** | Pointer over the marker, or keyboard focus | Marker `scale(1.12)` (200ms); focus also shows the focus ring (2px `--cs-focus`, offset 2px, round) |
| **Selected (balloon)** | Pin clicked, search result opened, deep link | `.pin.sel`: marker hidden; 40×54 green balloon whose tip is the anchor; 28px face with the emoji on `--bg`; label moves to `left:24px; top:-46px` at 15/19 + 12px. The pin moves to `floatPane` |
| **Buy flash** | Simulated/real buy event on that coin | `.pin.flash` (buy): 3px `--cs-green-bright` ring scales 1 → 2.3 and fades over 1.4s; tag `+1.2 SOL` (green pill, `left:21px; top:16px`, `right:21px` on `.left` pins). Runs **2 cycles (2.8s), then is removed**; a new trade restarts it. Not shown on the selected pin |
| **Sell flash** | Sell event | Same, with a `--cs-down` ring and a red tag `−2.5 SOL` |
| **Fees waiting dot** | Unclaimed and fees ≥ $500 | 12px `--cs-amber-bright` dot at `left:7px; top:-19px` with a 2px white ring (`title="Fees waiting"`) |
| **Owner-verified tick** | Shop claimed | 15px green circle with a white `check` (FILL, wght 700) at `left:5px; top:3px`. Replaces the fee dot (claimed shops never show it) |
| **Launchable** | A real Google POI with no coin is selected | `.pin.sel.launchable`: white dashed balloon, face = green `rocket_launch` (FILL, wght 500, 20px); label `Launch here` / `No coin yet`. Exists only while selected; removed when the panel closes |
| **New launch** | A coin is launched (by you or in the live feed) | The pin enters with the "pop" animation (§14); if you launched it, it is selected immediately |
| **Filtered out** | A chip filter excludes it | Not rendered |

Accessibility: each pin is a `<button>` with `aria-label="$KEBAB, Bosphorus Grill, up 12 percent, market cap $212k"` (launchable: `"Launch a coin here"`). Pins are reachable by Tab only after the map container has focus; tab order is market cap, descending.

### 7.3 User location dot
```css
.me{position:absolute;width:0;height:0}
.me i{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:var(--cs-loc);box-shadow:0 0 0 3px #fff,0 1px 4px 3px rgba(0,0,0,.25)}
.me::before{content:"";position:absolute;left:-36px;top:-36px;width:72px;height:72px;border-radius:50%;background:rgba(45,108,223,.16)}
```
- Shown only after the user taps Near me and grants permission (`navigator.geolocation.getCurrentPosition`, `enableHighAccuracy:false`, timeout 10s). Never stored and never sent to our server.
- The mock's halo is a fixed 72px. In the app, scale it to the reported `accuracy` in metres (min 72px, max 240px) using the projection.
- Not clickable; `aria-hidden`. Drawn in the same OverlayView, below the coin pins.

### 7.4 Google POIs (the basemap's own icons)
- `clickableIcons:true`. On a map `click` with `event.placeId`, call `event.stop()` to suppress Google's info window, then open the panel for that place ID: launched → launched panel; otherwise → launchable panel + launchable balloon at `event.latLng`.
- Do not restyle or hide `poi.business`. Optional JSON style: hide `transit` `labels.icon` only.

## 8. Place panel (desktop) / bottom sheet (mobile)

One React component (`PlacePanel`) renders into the side panel (≥768) or the bottom sheet (<768). It has two variants: **Launched** (place has a coin) and **Launchable** (real Google POI, no coin). Rail panels (§10) reuse the same container.

### 8.1 Container (desktop/tablet)
```css
.panel{position:fixed;left:0;top:0;bottom:0;width:calc(var(--rail-w) + var(--panel-w) + var(--panel-gutter));padding:var(--panel-gutter) var(--panel-gutter) var(--panel-gutter) var(--rail-w);background:var(--cs-rail);z-index:var(--z-panel);display:none}
body.panel-open .panel{display:block}
.panel-card{position:relative;height:100%;background:var(--cs-surface);border-radius:var(--cs-r-xl);overflow:hidden}
.panel-scroll{height:100%;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#c7c7c7 transparent}
.collapse-tab{position:absolute;left:100%;top:50%;margin-top:-24px;width:23px;height:48px;border-radius:0 8px 8px 0;background:var(--cs-rail);display:grid;place-items:center;color:var(--cs-icon)}
.collapse-tab .ms{font-size:22px}
```
Opening a different place replaces the content and resets `scrollTop` to 0. The search pill floats over the top 60px of the card, so the first 60px of content must be a photo/illustration (hero) or spacer (rail panels use `padding-top:76px`).

### 8.2 Hero (desktop/tablet only; hidden on mobile)
```css
.hero{position:relative;height:240px;background:#d9d4cc;overflow:hidden}
.hero img{width:100%;height:100%;object-fit:cover;display:block}
.hero::after{content:"";position:absolute;inset:auto 0 0 0;height:72px;background:linear-gradient(transparent,rgba(0,0,0,.28));pointer-events:none}
.hero-btn{position:absolute;left:15px;bottom:15px;height:36px;padding:0 12px 0 8px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;gap:6px;font-size:14px;line-height:20px;letter-spacing:.1px;z-index:1}
.hero-btn .ms{font-size:20px}
.hero-credit{position:absolute;right:12px;bottom:12px;font-size:11px;line-height:16px;color:rgba(255,255,255,.92);z-index:1;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.hero-credit a{color:inherit}
```

| Variant | Hero content |
|---|---|
| Launched, coin art uploaded | The launcher's uploaded image (`object-fit:cover`), `.hero-btn` `photo_library` + `Coin art`, credit `Uploaded by launcher` (demo shops: `Uploaded by launcher · Photo: Unsplash`) |
| Launched, sticker only | Background = coin `--bg`; centred 112px white circle with the emoji at 56px, `box-shadow:0 6px 18px rgba(0,0,0,.08)`; no button, no credit |
| Launchable | `.lhero` illustration (§8.6), height 200px |
| Loading | `--cs-hero-placeholder` block (skeleton shimmer, §13.3) |

**Never** put a Google photo in the hero (the brief bans Google photos as coin art). Google photos appear only inside Google's element (§9).

### 8.3 Mobile bottom sheet
```css
.panel{display:none;left:0;right:0;top:auto;bottom:0;width:auto;height:var(--sheet-h);padding:0;background:transparent;z-index:var(--z-sheet);transition:height var(--cs-dur-4) var(--cs-ease)}
.panel-card{border-radius:var(--cs-r-2xl) var(--cs-r-2xl) 0 0;box-shadow:var(--cs-elev-sheet)}
.handle{display:block;position:absolute;left:0;right:0;top:0;height:22px;z-index:3;cursor:grab}
.handle::before{content:"";position:absolute;left:50%;top:8px;width:32px;height:4px;margin-left:-16px;border-radius:2px;background:#c4c7c5}
.panel-scroll{padding-top:14px}
.ph-x{position:absolute;right:12px;top:18px;display:flex;gap:8px;z-index:4}
.ph-x button{width:40px;height:40px;border-radius:50%;background:var(--cs-surface-2);display:grid;place-items:center;color:var(--cs-text)}
.ph-x .ms{font-size:20px}
```

| Snap | `--sheet-h` | Shows |
|---|---|---|
| Peek | `148px` | Handle, title row with Share/Close, ticker line. Scroll locked |
| Half (default on open) | `52dvh` | As the mobile screenshot: header, pills, strip, tabs |
| Full | `calc(100dvh - 72px)` | Everything; content scrolls; the search pill stays visible above |

- Drag the handle **or** the header area (anything above the pills): the sheet follows the finger 1:1; on release snap to the nearest snap point, or to the next one in the fling direction if velocity > 0.5 px/ms. Dragging down from Peek closes the panel.
- When the content is scrolled to the top in Full, dragging down on the content drags the sheet (Maps behaviour). Otherwise the content scrolls.
- Tap the handle: cycles Peek → Half → Full → Peek (the mock's behaviour). Keyboard: the handle is `role="button" tabindex="0"` with `aria-label="Resize sheet"`; Enter/Space cycle; ↑/↓ move one snap.
- The map's `bottom` follows `--sheet-h`; trigger a map resize 460ms after a snap (after the 450ms height transition).
- `.ph-x` (mobile only): `Share` (`share` icon) and `Close` (`close` icon), 40×40 visual inside a 44×44 hit area.

### 8.4 Header block (`.ph`)
```css
.ph{padding:16px 24px 4px}                    /* mobile: padding:8px 16px 4px */
.ph-title{margin:0;font-size:22px;line-height:28px;font-weight:500;letter-spacing:0;font-variation-settings:'opsz' 28}  /* mobile: padding-right:96px */
.ph-row{display:flex;align-items:center;flex-wrap:wrap;gap:0 4px;font-size:14px;line-height:20px;color:var(--cs-text-2);letter-spacing:.1px}
.dot-sep{font-weight:700;padding:0 2px}
.ph-coin{margin-top:10px;display:flex;align-items:center;gap:8px;font-size:14px;line-height:20px}
.ticker{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:6px;background:var(--cs-green-container);color:var(--cs-on-green-container);font-weight:700;font-size:13px;letter-spacing:.2px}
.ticker.ghost{background:transparent;border:1px dashed var(--cs-green);color:var(--cs-green)}
.ph-coin .price{font-weight:600;color:var(--cs-text)}
.chg{display:inline-flex;align-items:center;gap:1px;font-weight:600}
.ph-unclaimed{margin-top:6px;display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;letter-spacing:.2px;color:var(--cs-text-2)}
.ph-unclaimed .ms{font-size:16px;color:var(--cs-text-3)}
.ph-unclaimed.verified{color:var(--cs-on-green-container)}
.ph-unclaimed.verified .ms{color:var(--cs-green)}
```
**Launched header** (order is fixed):
1. `.ph-title` = **coin name** as typed by the launcher (e.g. `Bosphorus Grill`). Never Google's `displayName`.
2. `.ph-coin`: `.ticker` `$KEBAB` · `.price` `$0.000212` · `.chg` `▲ 12.4%` · `.muted` `· $212k mcap`.
3. `.ph-row` (margin-top 6px): `Kebab shop coin` · `1,284 holders` · `launched 3d ago` (category is the launcher's pick).
4. `.ph-unclaimed`:

| Owner state | Icon | Text | Trailing |
|---|---|---|---|
| Unclaimed | `storefront` (`--cs-text-3`) | `Unclaimed · not affiliated with this business` | `info` 15px button → tooltip/popover (§16) |
| Claim pending (manual review) | `schedule` | `Owner verification in progress` | — |
| Claimed (`.verified`) | `verified` FILL (`--cs-green`) | `Claimed · verified owner` | `info` button |
| You are the owner | `verified` FILL | `You own this shop · fees go to 7xKX…3pQa` | — |

`.ticker.ghost` is the "not yet launched" ticker preview (launch modal review, launchable header if the user typed a ticker earlier).

### 8.5 Panel composition (order of blocks)

| # | Launched — desktop/tablet | Launched — mobile | Launchable — desktop/tablet | Launchable — mobile |
|---|---|---|---|---|
| 1 | `.hero` 240px | handle + `.ph-x` | `.lhero` 200px | handle + `.ph-x` |
| 2 | `.ph` header | `.ph` header | `.ph` launchable header | `.ph` launchable header |
| 3 | `.tabs` (sticky) | `.pills` | `.tabs` (Coin disabled) | `.pills` |
| 4 | **Overview:** `.actions` | `.strip` (chart card · fee mini · coin art) | **Overview:** `.actions` | `.tabs` (Coin disabled) |
| 5 | `.fees` card | `.tabs` (sticky) | `.steps` | **Overview:** `.steps` |
| 6 | `.coin` summary | **Overview:** Google block (§9) | Google block (§9) | Google block (§9) |
| 7 | Google block (§9) | `.trades` (5 rows) | `.foot` | `.foot` |
| 8 | `.trades` (5 rows) | CA + link rows | | |
| 9 | CA + link rows (§8.12) | `.foot` | | |
| 10 | `.foot` | | | |

Tab contents other than Overview (all variants, all breakpoints):
- **Coin** (launched): `.coin` summary (mobile: full-width, spark height 120px) → `.trade` box → `.trades` (20 rows + `Show more` text button, loads 20 more) → `Top holders` section (10 `.trow`-style rows: rank, address, % of supply) → CA + link rows. Launchable: tab is `disabled` with `opacity:.45` and `aria-disabled="true"`, tooltip `No coin yet`.
- **About**: `About this coin` info rows (`rocket_launch` Launched by `7xKX…3pQa` · `schedule` `Launched 4 Oct 2026` · `storefront` Category `Kebab shop` · `toll` `Launchpad: pump.fun`) → `Fees & owner` rows (`payments` `100% of creator fees go to this shop's vault` · `verified` owner state · `call` `Owners verify by a phone call to the number on the Google listing`) → `.foot`. Launchable About: `How it works` (the 3 `.steps` rows, full width) → `.foot`.
- The Google block is rendered **once** (Overview) and kept mounted (hidden) when switching tabs, so Google's element is not re-requested.

### 8.6 Launchable place (selected real POI with no coin)
```css
.lhero{position:relative;height:200px;overflow:hidden;background:radial-gradient(120% 90% at 70% 10%,#e8f8ee 0%,#d2f0dd 45%,#bfe6cf 100%)}
.lh-coin{position:absolute;left:50%;top:58%;width:96px;height:96px;margin:-48px 0 0 -48px;border-radius:50%;background:#fff;border:2.5px dashed var(--cs-green);display:grid;place-items:center;color:var(--cs-green);box-shadow:0 6px 18px rgba(14,124,71,.18)}
.lh-coin .ms{font-size:40px}
.lh-ghost{position:absolute;border-radius:50%;background:rgba(255,255,255,.55);box-shadow:inset 0 0 0 2px rgba(14,124,71,.12)}
.lh-ghost.g1{width:56px;height:56px;left:72px;top:96px}
.lh-ghost.g2{width:40px;height:40px;right:84px;top:132px}
.lh-ghost.g3{width:28px;height:28px;right:120px;top:84px}
.lh-cap{position:absolute;left:16px;bottom:14px;height:28px;padding:0 10px;border-radius:14px;background:rgba(255,255,255,.85);font-size:12px;font-weight:600;color:var(--cs-on-green-container);display:flex;align-items:center}
.steps{list-style:none;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 16px 0;padding:12px;border-radius:var(--cs-r-lg);background:var(--cs-green-tint)}
.steps li{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:16px}
.steps b{display:block;font-size:13px;font-weight:600;color:var(--cs-text)}
.steps small{color:var(--cs-text-2);font-size:11.5px}
.sn{width:20px;height:20px;border-radius:50%;background:var(--cs-green);color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center;flex:none}
```
- `.lhero` (desktop/tablet): three ghost circles, the 96px dashed coin with `rocket_launch` FILL 40px, caption chip `No coin yet`. `aria-hidden`.
- Header: `.ph-title` `Be the first to launch this shop` · `.ph-row` `One coin per place` · `first launch wins` · `.ph-unclaimed` with `payments` icon: `100% of creator fees are held for the owner`. The place's name/address/rating come only from Google's element below (we never fetch `displayName` just to show it here).
- `.steps`: ① `Launch` / `~20 seconds` ② `People trade` / `fees build up` ③ `Owner claims` / `phone check`. Static, non-interactive.
- If the place ID turns out to already have a coin (race), swap to the Launched variant with toast `This shop already has a coin — $TICKER`.

### 8.7 Action row (desktop/tablet) and pills (mobile)
```css
.actions{display:flex;justify-content:space-between;padding:10px 22px}
.act{width:73px;display:flex;flex-direction:column;align-items:center;gap:8px;padding:4px 0}
.act .circ{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:var(--cs-green-container);color:var(--cs-on-green-container);transition:background var(--cs-dur-2) var(--cs-ease),box-shadow var(--cs-dur-2) var(--cs-ease)}
.act .circ .ms{font-size:20px}
.act:hover .circ{box-shadow:0 1px 2px rgba(60,64,67,.3),0 1px 3px 1px rgba(60,64,67,.15)}
.act .t{font-size:12px;line-height:16px;font-weight:500;letter-spacing:.2px;color:var(--cs-on-green-container);text-align:center}
.act.primary .circ{background:var(--cs-green);color:#fff}
.act.primary:hover .circ{background:var(--cs-green-hover)}
.act.primary .t{color:var(--cs-green);font-weight:600}
.act[disabled]{opacity:.38;cursor:default}
/* mobile */
.pills{display:flex;gap:8px;overflow-x:auto;padding:12px 16px 4px;scrollbar-width:none}
.pills::-webkit-scrollbar{display:none}
.pills .btn{height:40px;padding:0 18px 0 16px;flex:none;font-weight:600}
.pills .btn-outline{color:var(--cs-text)}
```

| Variant | Desktop `.act` (left → right; first is `.primary`) | Mobile `.pills` (first is `.btn-primary`, rest `.btn-outline`) |
|---|---|---|
| Launched | `add_shopping_cart` **Buy** · `sell` Sell · `ios_share` Share · `verified` Claim · `open_in_new` Open in Maps | `add_shopping_cart` **Buy $KEBAB** · `sell` Sell · `verified` Claim · `ios_share` Share · `open_in_new` Open in Maps |
| Launchable | `rocket_launch` **Launch** · `notifications` Watch · `ios_share` Share · `verified` Claim · `open_in_new` Open in Maps | `rocket_launch` **Launch a coin** · `notifications` Watch · `verified` Claim · `ios_share` Share · `open_in_new` Open in Maps |

States: Claim → when claimed, the label becomes `Owner` with `verified` FILL and opens the owner info popover; when *you* are the owner it becomes `Payouts`. Watch → `Watching` with `notifications_active` FILL once on. Sell is `disabled` when the connected wallet holds 0 of the coin (tooltip `You don't hold $KEBAB`); when disconnected it stays enabled and asks you to connect. Primary icons use FILL.

### 8.8 Tabs
```css
.tabs{display:flex;border-bottom:1px solid var(--cs-outline);margin-top:12px;position:sticky;top:0;background:var(--cs-surface);z-index:2}
.tab{flex:1;height:48px;position:relative;font-size:14px;line-height:20px;font-weight:500;letter-spacing:.1px;color:var(--cs-text-2)}
.tab:hover{background:var(--cs-state-hover)}
.tab.active{color:var(--cs-green)}
.tab.active::after{content:"";position:absolute;left:50%;transform:translateX(-50%);bottom:0;width:calc(100% - 48px);min-width:40px;height:3px;border-radius:3px 3px 0 0;background:var(--cs-green)}
```
Labels: `Overview` · `Coin` · `About`. `role="tablist"`, each `role="tab"` with `aria-selected` / `aria-controls`; ←/→ move focus and select. The indicator slides between tabs (200ms `--cs-ease`). Switching tabs scrolls the panel so the tabs bar is at the top only if it was already stuck; otherwise the scroll position is kept.

### 8.9 Fees-waiting card (desktop/tablet) + fee mini (mobile)
```css
.fees{margin:8px 16px 4px;border-radius:var(--cs-r-lg);background:var(--cs-amber-container);padding:14px 16px 16px;color:var(--cs-on-amber-container)}
.fees-top{display:flex;gap:12px;align-items:flex-start}
.fees-ic{width:36px;height:36px;border-radius:50%;background:#fff;display:grid;place-items:center;flex:none;color:var(--cs-amber)}
.fees-ic .ms{font-size:20px}
.fees h3{margin:0;font-size:16px;line-height:22px;font-weight:600;color:var(--cs-on-amber-container)}
.fees h3 b{font-weight:800}
.fees .sol{display:block;margin-top:1px;font-size:12px;line-height:16px;font-weight:600;color:#7d5426}   /* NEW: SOL secondary */
.fees p{margin:2px 0 0;font-size:12px;line-height:16px;letter-spacing:.2px;color:#7d5426}
.fees-cta{display:flex;align-items:center;gap:12px;margin-top:12px;padding-left:48px}
.fees-cta .btn{height:36px;padding:0 16px}
.fees-cta .link{font-size:12px;font-weight:500;color:var(--cs-on-amber-container);text-decoration:underline;text-underline-offset:2px}
/* mobile strip card */
.fee-mini{display:flex;flex:none;width:196px;height:132px;border-radius:16px;background:var(--cs-amber-container);color:var(--cs-on-amber-container);padding:10px 12px;flex-direction:column;align-items:flex-start}
.fee-mini .ms{font-size:20px;color:var(--cs-amber)}
.fee-mini b{font-size:20px;line-height:26px;font-weight:800;margin-top:2px}
.fee-mini b span{font-size:12px;font-weight:600;color:#7d5426;margin-left:6px}  /* NEW: "≈ 8.27 SOL" */
.fee-mini small{font-size:12px;line-height:16px}
.fee-mini .btn{height:32px;padding:0 12px;font-size:12px;margin-top:auto}
```

| State | Card | CTA row |
|---|---|---|
| Unclaimed, fees > 0 | `payments` icon · h3 `<b>$1,240</b> waiting for this shop` · `.sol` `≈ 8.27 SOL` · p `100% of creator fees from $KEBAB are held for the owner. We take nothing.` | `.btn-amber` `storefront` `I own this business` + link `Learn more` |
| Unclaimed, fees = 0 | h3 `Fees for this shop build up here` · p as above | Same |
| Verification in progress (someone else) | h3 as fees>0 · p `An owner is verifying right now.` | Button `disabled`, label `Verification in progress` |
| Claimed (visitor) | bg `--cs-green-tint`, color `--cs-on-green-container`, icon `verified` FILL `--cs-green` · h3 `Claimed by the owner` · p `<b>$3,410</b> paid to the shop so far · ≈ 22.73 SOL` | Link `Learn more` only |
| You are the owner | Same green treatment · h3 `<b>$1,240</b> earned for your shop` · p `Paid to 7xKX…3pQa · first payout after the 72-hour hold` | `.btn-tonal` `Payout settings` |

Mobile `.fee-mini` mirrors the state: icon · `<b>$1,240<span>≈ 8.27 SOL</span></b>` · `waiting for this shop` · `.btn-amber` `I own this business` (claimed: green-tint card, `Claimed` + no button).

### 8.10 Coin summary: price, sparkline, timeframe toggle, stats
```css
.coin{padding:12px 16px 4px}
.coin-head{padding:0 8px;display:flex;align-items:flex-end;justify-content:space-between}
.coin-price{font-size:28px;line-height:34px;font-weight:650;letter-spacing:-.3px;font-variant-numeric:tabular-nums;font-variation-settings:'opsz' 32}
.coin-sub{font-size:12px;line-height:16px;color:var(--cs-text-2);letter-spacing:.2px;margin-top:2px}
.coin-sub .chg{font-size:12px}
.seg{display:inline-flex;gap:2px;background:var(--cs-surface-2);border-radius:16px;padding:2px}
.seg button{height:28px;padding:0 10px;border-radius:14px;font-size:12px;font-weight:600;color:var(--cs-text-2)}
.seg button.on{background:#fff;color:var(--cs-text);box-shadow:0 1px 2px rgba(60,64,67,.25)}
.spark{display:block;width:100%;height:84px;margin:10px 0 6px}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--cs-divider);border:1px solid var(--cs-divider);border-radius:var(--cs-r-md);overflow:hidden;margin-top:4px}
.stat{background:#fff;padding:10px 14px}
.stat .k{font-size:12px;line-height:16px;color:var(--cs-text-2);letter-spacing:.2px}
.stat .v{font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:1px}
/* mobile strip */
.strip{display:flex;gap:8px;overflow-x:auto;padding:12px 16px 4px;scrollbar-width:none}
.strip .chart-card{flex:none;width:196px;height:132px;border-radius:16px;border:1px solid var(--cs-divider);padding:10px 12px;display:flex;flex-direction:column}
.strip .chart-card .k{font-size:12px;color:var(--cs-text-2)}
.strip .chart-card .v{font-size:20px;line-height:26px;font-weight:650;font-variant-numeric:tabular-nums}
.strip .chart-card svg{flex:1;width:100%;margin-top:4px}
.strip .ph-img{flex:none;width:168px;height:132px;border-radius:16px;overflow:hidden;position:relative}
.strip .ph-img img{width:100%;height:100%;object-fit:cover}
.strip .ph-img small{position:absolute;left:8px;bottom:6px;font-size:10px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)}
```
- Head: `.coin-price` `$0.000212`; `.coin-sub` `▲ 12.4% past 24h`. Timeframe `.seg` (`role="radiogroup"`, `aria-label="Chart range"`): `1H` · `24H` (default) · `7D` · `All`. The sub label follows: `past hour` · `past 24h` · `past 7 days` · `all time`.
- Sparkline: SVG `viewBox="0 0 360 64" preserveAspectRatio="none"`, 84px tall (Coin tab on mobile: 120px), 48 points. Up: stroke `#0e7c47` 2px `stroke-linejoin:round`, area gradient `#15a35a` opacity .22 → 0, end dot r=4 `#0e7c47` with 2px white stroke. **Down** (change < 0): stroke `--cs-down`, gradient `#cc2f3a` .18 → 0, red end dot. No axes, no grid.
- Scrub (pointer/touch drag over the spark): 1px `--cs-outline` vertical line + 8px dot at the nearest point; `.coin-price` and `.coin-sub` show that point's price and `▲ x% · 14:20` (time in 24h local); release restores. Keyboard: the spark is focusable, ←/→ step points, Esc restores. `aria-label="Price chart, past 24h, up 12.4%"`.
- Stats (2×2): `Market cap` `$212k` · `Volume 24h` `$48.1k` · `Holders` `1,284` · `Fees earned` `$1,240` (value in `.amb` = `--cs-amber`).
- Mobile `.strip`: `.chart-card` (`$KEBAB · 24h`, `.v` price + change, 172×64 spark), `.fee-mini`, `.ph-img` (coin art, caption `Coin art`; hidden for sticker-only coins).
- Live updates: price ticks every 3–8s in the simulator; the changed number flashes its up/down colour background (`--cs-up-bg` / `--cs-down-bg`) for 600ms (§14).

### 8.11 Buy / sell box (`.trade`)
```css
.trade{margin:12px 24px 16px;border:1px solid var(--cs-divider);border-radius:var(--cs-r-lg);padding:12px}   /* mobile: margin 12px 16px 16px */
.trade-tabs{display:grid;grid-template-columns:1fr 1fr;background:var(--cs-surface-2);border-radius:12px;padding:3px;gap:3px}
.trade-tabs button{height:34px;border-radius:9px;font-weight:600;font-size:14px;color:var(--cs-text-2)}
.trade-tabs button.on{background:#fff;color:var(--cs-green);box-shadow:0 1px 2px rgba(60,64,67,.25)}
.trade-tabs button.on.sell{color:var(--cs-down)}                         /* NEW */
.field{margin-top:12px;display:flex;align-items:center;height:56px;border:1px solid var(--cs-outline);border-radius:12px;padding:0 12px 0 16px;gap:8px}
.field:focus-within{border:2px solid var(--cs-green);padding-left:15px}
.field input{flex:1;border:0;outline:0;font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;min-width:0;background:transparent}
.field .unit{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px 0 6px;border-radius:16px;background:var(--cs-surface-2);font-size:13px;font-weight:600}
.sol{width:20px;height:20px;border-radius:50%;background:#000;display:grid;place-items:center}   /* replaces the mock's .eth */
.sol svg{width:12px;height:10px}
.quick{display:flex;gap:6px;margin-top:8px}
.quick button{flex:1;height:32px;border-radius:8px;border:1px solid var(--cs-outline-2);font-size:12px;font-weight:600;color:var(--cs-text-2)}
.quick button:hover{background:var(--cs-state-hover)}
.receive{display:flex;justify-content:space-between;font-size:12px;line-height:16px;color:var(--cs-text-2);margin:10px 2px}
.receive b{color:var(--cs-text);font-weight:600}
.demo-note{display:flex;align-items:center;justify-content:center;gap:4px;margin-top:8px;font-size:11px;line-height:16px;color:var(--cs-text-3)}
.demo-note .ms{font-size:14px}
```
SOL glyph (inside `.sol`; currency marker only):
```html
<svg viewBox="0 0 12 10" aria-hidden="true"><defs><linearGradient id="solg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9945ff"/><stop offset="1" stop-color="#14f195"/></linearGradient></defs><path fill="url(#solg)" d="M2.2 0H12L9.8 2.4H0zM0 3.8h9.8L12 6.2H2.2zM2.2 7.6H12L9.8 10H0z"/></svg>
```

| Element | Buy tab (default) | Sell tab |
|---|---|---|
| Tabs | `Buy` (on, green) | `Sell` (on, red text) |
| Field | Input placeholder `0.0`, unit pill `.sol` + `SOL` | Input placeholder `0`, unit pill coin emoji (16px on `--bg`, 20px circle) + `$KEBAB` |
| Quick buttons | `0.1 SOL` · `0.5 SOL` · `1 SOL` (set the input) | `25%` · `50%` · `100%` (of holdings) |
| Receive row | `You receive` · `<b>≈ 2.36M $KEBAB</b>` | `You receive` · `<b>≈ 0.48 SOL</b>` |
| Second row (12/16 text-2) | `Balance 2.41 SOL` (left) · `Slippage 2%` (right) | `You hold 4.1M $KEBAB` · `Slippage 2%` |
| Button (`.btn-primary.btn-block`) | `Buy $KEBAB` | `Sell $KEBAB` (bg `--cs-down`, hover `#b02631`) |
| Note | `.demo-note` `info` `Demo — no real transaction` | Same |

Button states: disconnected → `Connect wallet to buy` / `…to sell`; empty/zero input → disabled `Enter an amount`; amount > balance → disabled `Not enough SOL` / `Not enough $KEBAB`; submitting → spinner + `Buying…` / `Selling…` (1.2s simulated); success → toast + the input clears. Input accepts digits and one `.`, max 9 decimals for SOL.

### 8.12 Recent trades, info rows, CA copy row, link rows
```css
.trades{padding:4px 0 8px}
.trades h4,.sec-h{margin:0;padding:12px 24px 4px;font-size:16px;line-height:22px;font-weight:600}
.trow{display:flex;align-items:center;gap:12px;padding:8px 24px;font-size:13px;line-height:18px}
.trow .who{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.blob{width:28px;height:28px;border-radius:50%;flex:none}
.trow .side{font-weight:600}
.trow .amt{font-variant-numeric:tabular-nums;color:var(--cs-text)}
.trow .ago{color:var(--cs-text-3);width:44px;text-align:right;font-size:12px}
.info{padding:8px 0}
.irow{display:flex;align-items:center;min-height:48px;padding:8px 24px;gap:24px;font-size:14px;line-height:20px;letter-spacing:.1px;cursor:pointer;position:relative}   /* mobile: padding 8px 16px; gap 20px */
.irow:hover{background:var(--cs-state-hover)}
.irow > .ms{color:var(--cs-green);flex:none}
.irow .main{flex:1;min-width:0}
.irow .main small{display:block;font-size:12px;line-height:16px;color:var(--cs-text-2);letter-spacing:.2px}
.irow .trail{color:var(--cs-icon);font-size:20px}
```
- **Recent trades**: heading `Recent trades`; row = `.blob` (gradient picked by hashing the address into the mock's 5: `linear-gradient(135deg,#7ad3a3,#0e7c47)`, `…#ffd27a,#f59e0b`, `…#a8c3ff,#5b7bd5`, `…#ffb3b8,#cc2f3a`, `…#d1b3ff,#7b4fd5`) · mono 12px address `3cHq…91aB` · `.side` `Bought` (`.up`) / `Sold` (`.down`) · `.amt` `1.2 SOL` · `.ago` `12s`. Overview shows 5, Coin tab 20. New trades slide in at the top (`rowin`, §14). Empty: `No trades yet. Be the first to buy.` (14/20 text-2, padding 8 24). Rows are links to the Solscan tx (`https://solscan.io/tx/<signature>`) for real coins; simulated rows are plain text (no hover, no cursor).
- **CA copy row** (`.irow`): `toll` · `.main` mono `BkT7…pump` + `small` `$KEBAB mint · Solana · pump.fun` · `.trail` `content_copy`. The whole row is one `<button>` (`aria-label="Copy mint address"`); on copy the trailing icon swaps to `check` (`--cs-green`) for 1.5s.
- **Link rows** (same `.irow`, trailing `open_in_new`): `public` `View on Solscan` · `candlestick_chart` `Chart on DexScreener` · `rocket_launch` `Trade on pump.fun`. URLs: `https://solscan.io/token/<mint>`, `https://dexscreener.com/solana/<mint>`, `https://pump.fun/coin/<mint>`; `target="_blank" rel="noopener noreferrer"`. For simulated coins see §18 (toast instead of navigation).

### 8.13 Footer
```css
.foot{padding:16px 24px 28px;font-size:12px;line-height:16px;color:var(--cs-text-3);letter-spacing:.2px}   /* mobile padding-left/right 16px */
.foot a{color:var(--cs-text-2)}
```
- Launched: `Coins are launched by anyone. The business has not endorsed this coin. Report · Business opt-out`.
- Launchable: `Coins on CORNERSHOP are launched by the public and are not affiliated with the business. Business opt-out`.
- `Report` and `Business opt-out` are buttons styled as links (open the report sheet / opt-out form, §18).

## 9. Composing with Google's Places UI Kit

Decision (BRIEF "Research-driven decisions"): Google's place content (photos, rating, type, price, hours, address, phone, website) is rendered by **Google's own Places UI Kit element** inside our panel. We never build that content ourselves for real places, and we never fetch Places fields just to display them. Property names below are from Google's `places-widget` reference (checked 2026-10-07): https://developers.google.com/maps/documentation/javascript/reference/places-widget.

### 9.1 Stacking inside the panel
```
┌ panel-card ───────────────────────────────┐
│ CORNERSHOP COIN BLOCK (ours)              │
│  hero / lhero                             │
│  .ph  title row · ticker/price line ·     │
│       unclaimed line                      │
│  .tabs  Overview | Coin | About           │
│  .actions (Buy/Launch … Open in Maps)     │
│  .fees card · .coin summary               │
├───────────────────────────────────────────┤
│ .sec-title  "About this place"            │
│ ┌ .gmp wrapper (1px divider, r16) ──────┐ │
│ │ <gmp-place-details>  ← GOOGLE         │ │
│ │  photos · rating · type · price ·     │ │
│ │  open now · address · hours ·         │ │
│ │  website · phone · Google attribution │ │
│ └───────────────────────────────────────┘ │
├───────────────────────────────────────────┤
│ CORNERSHOP (ours): Recent trades · CA row │
│ · link rows · footer                      │
└───────────────────────────────────────────┘
```
Rules:
- Google's element always sits in its **own bordered card** with our section title `About this place` above it (`.sec-title`, §9.4). Nothing of ours is drawn inside, over or overlapping it; nothing of Google's is drawn inside our coin block. This visual separation is required by Google's attribution policy.
- Width: desktop/tablet 376px (408 − 2×16 margin) and mobile `100vw − 32px`. Both are inside Google's recommended 250–400px. **No fixed height**: the element grows and the panel scrolls.
- Render it once per selected place (Overview tab), keep it mounted when switching tabs, and unmount it when the panel closes. Each mount is a billed request.
- Our action row keeps its own `Open in Maps`. Google's element also shows an "Open in Maps" button; that duplicate is expected and must **not** be hidden.

### 9.2 Full element (panel)
Load with `await google.maps.importLibrary('places')` before mounting. Markup (as the mock):
```html
<gmp-place-details class="gmp">
  <gmp-place-details-place-request place="ChIJ…"></gmp-place-details-place-request>
  <gmp-place-content-config>
    <gmp-place-media lightbox-preferred></gmp-place-media>
    <gmp-place-rating></gmp-place-rating>
    <gmp-place-type></gmp-place-type>
    <gmp-place-price></gmp-place-price>
    <gmp-place-accessible-entrance-icon></gmp-place-accessible-entrance-icon>
    <gmp-place-open-now-status></gmp-place-open-now-status>
    <gmp-place-address></gmp-place-address>
    <gmp-place-opening-hours></gmp-place-opening-hours>
    <gmp-place-website></gmp-place-website>
    <gmp-place-phone-number></gmp-place-phone-number>
    <gmp-place-attribution light-scheme-color="gray" dark-scheme-color="white"></gmp-place-attribution>
  </gmp-place-content-config>
</gmp-place-details>
```
React 18 notes: render the custom elements directly (attributes as strings; boolean attribute `lightbox-preferred=""`). `gmp-load` and `gmp-error` **do not bubble**: attach them with `ref.current.addEventListener` in an effect. Changing place = change the `place` attribute on the request element (or re-key the component).

### 9.3 Styling the element (CSS custom properties)
Put these on the `.gmp` class (they inherit into the element's shadow DOM). The first block is the mock's, verbatim; the second block adds the properties the mock missed.
```css
.gmp,.gblock{display:block;margin:0 16px;border:1px solid var(--cs-divider);border-radius:var(--cs-r-lg);background:#fff;overflow:hidden;color-scheme:light;
  --gmp-mat-font-family:var(--cs-font);
  --gmp-mat-color-surface:#ffffff;
  --gmp-mat-color-on-surface:var(--cs-text);
  --gmp-mat-color-on-surface-variant:var(--cs-text-2);
  --gmp-mat-color-primary:var(--cs-green);
  --gmp-mat-color-positive:var(--cs-up);
  --gmp-mat-color-negative:var(--cs-down);
  --gmp-mat-color-info:var(--cs-loc);
  --gmp-mat-color-secondary-container:var(--cs-green-container);
  --gmp-mat-color-on-secondary-container:var(--cs-on-green-container);
  --gmp-mat-color-neutral-container:var(--cs-surface-2);
  --gmp-mat-color-on-neutral-container:var(--cs-text-2);
  --gmp-mat-color-outline-decorative:var(--cs-divider);
  --gmp-mat-color-disabled-surface:#dadce0;
  --gmp-mat-font-headline-medium:500 22px/28px var(--cs-font);
  --gmp-mat-font-display-small:500 22px/28px var(--cs-font);
  --gmp-mat-font-title-small:500 14px/20px var(--cs-font);
  --gmp-mat-font-body-medium:400 14px/20px var(--cs-font);
  --gmp-mat-font-body-small:400 12px/16px var(--cs-font);
  --gmp-mat-font-label-large:500 14px/20px var(--cs-font);
  --gmp-mat-font-label-medium:500 12px/16px var(--cs-font)}

/* additions (documented by Google, not set in the mock) */
.gmp{
  background-color:#ffffff;                                  /* element background override */
  border:1px solid var(--cs-divider);                        /* element border override */
  border-radius:var(--cs-r-lg);                              /* 16px, matches our cards */
  font-size:16px;                                            /* keep Google's default; it scales internal em sizes and icons */
  --gmp-mat-color-positive-container:var(--cs-up-bg);
  --gmp-mat-color-on-positive-container:var(--cs-on-green-container);
  --gmp-star-rating-color:var(--cs-star);
  --gmp-button-border-color:var(--cs-outline-2);             /* Google's "Open in Maps" button → looks like our .btn-outline */
  --gmp-button-border-width:1px;
  --gmp-button-border-radius:20px;
  --gmp-collage-border-radius-outer:14px;                    /* matches the mock's .gb-media */
  --gmp-dialog-border-radius:28px;                           /* Google disclosures dialog = our dialog radius */
}
.gmp-compact{                                                /* <gmp-place-details-compact> (modals) */
  display:block;color-scheme:light;background-color:#ffffff;border:1px solid var(--cs-divider);border-radius:var(--cs-r-md);
  --gmp-mat-font-family:var(--cs-font);
  --gmp-mat-color-on-surface:var(--cs-text);
  --gmp-mat-color-on-surface-variant:var(--cs-text-2);
  --gmp-mat-color-primary:var(--cs-green);
  --gmp-mat-color-positive:var(--cs-up);
  --gmp-mat-color-negative:var(--cs-down);
  --gmp-mat-color-info:var(--cs-loc);
  --gmp-mat-color-secondary-container:var(--cs-green-container);
  --gmp-mat-color-on-secondary-container:var(--cs-on-green-container);
  --gmp-mat-color-neutral-container:var(--cs-surface-2);
  --gmp-mat-color-outline-decorative:var(--cs-divider);
  --gmp-mat-font-title-small:600 14px/20px var(--cs-font);   /* place name in compact */
  --gmp-mat-font-body-small:400 12px/16px var(--cs-font);
  --gmp-mat-font-label-large:500 14px/20px var(--cs-font);
  --gmp-mat-font-label-medium:500 12px/16px var(--cs-font);
  --gmp-star-rating-color:var(--cs-star);
  --gmp-thumbnail-border-radius:12px;
  --gmp-button-border-radius:20px;
  --gmp-dialog-border-radius:28px;
}
```
Do **not** set: the `--gmp-mat-spacing-*` properties (Google's defaults sit on the same 4px grid), anything that hides, recolours (other than `light-scheme-color="gray"`) or covers `gmp-place-attribution`, or `color-scheme: dark`. Test the element in light mode only (we force `color-scheme:light`).

### 9.4 Section title, loading and error around the element
```css
.sec-title{display:flex;align-items:center;justify-content:space-between;padding:20px 24px 10px;font-size:16px;line-height:22px;font-weight:600}  /* mobile padding-left/right 16px */
```

| State | What renders inside the `.gmp` wrapper slot |
|---|---|
| Loading (mounted, before `gmp-load`) | Skeleton overlay inside a 16px-radius bordered box, `min-height:320px`: 218px media block (2-column collage, 4px gaps, radius 14) → 3 text bars (60% × 22px, 40% × 14px, 70% × 14px) → 4 info-row bars (24px icon circle + 60% bar). Removed on `gmp-load` (fade 200ms) |
| Loaded | Google's element only |
| Error (`gmp-error`, or no `gmp-load` within 8s) | Same bordered box, padding 20: `error` icon 24px `--cs-text-3`, title `Couldn't load details for this place` (14/20 600), sub `Your coin info above still works.` (12/16 text-2), buttons `.btn-text` `refresh` `Try again` (re-mounts the element) and `.btn-text` `open_in_new` `Open in Google Maps` |
| Fallback map mode (MapLibre/OSM; no Google) | No Google element and no Google IDs. A `.gblock` with header `OpenStreetMap place` + OSM name/address rows; footer credit `© OpenStreetMap contributors`. `Launch` is disabled (tooltip `Launching needs Google Maps. Try again later.`) because coins key on Google place IDs |

### 9.5 Compact element (modals)
Used where a modal must show *which* place you're acting on without building our own place card: the launch modal (Details step header and Review step) and the claim modal (Verify step).
```html
<gmp-place-details-compact class="gmp-compact" orientation="horizontal" truncation-preferred>
  <gmp-place-details-place-request place="ChIJ…"></gmp-place-details-place-request>
  <gmp-place-content-config>
    <gmp-place-media></gmp-place-media>
    <gmp-place-rating></gmp-place-rating>
    <gmp-place-type></gmp-place-type>
    <gmp-place-address></gmp-place-address>
    <gmp-place-attribution light-scheme-color="gray" dark-scheme-color="white"></gmp-place-attribution>
  </gmp-place-content-config>
</gmp-place-details-compact>
```
Width = dialog content width (472px desktop; on mobile < 350px the thumbnail hides automatically, which is fine). No fixed height. Loading: a 72px skeleton bar. Error: one line `Place details unavailable` + the place ID's `Open in Google Maps` link.

### 9.6 Demo-shop lookalike (`.gblock`) — FICTIONAL shops only
Seeded demo coins are fictional and have no Google place, so the mock renders a lookalike `PlaceInfo` block. Keep it for demo shops only; **never** render it for a real place ID, and never put the word "Google" or a Google logo in it.
```css
.gb-attr{height:48px;display:flex;align-items:center;gap:8px;padding:0 20px;border-bottom:1px solid var(--cs-divider);font-size:13px;color:var(--cs-text-2)}
.gb-attr .ms{font-size:18px;color:var(--cs-text-2)}
.gb-demo{font-weight:500;color:#5e5e5e}
.gb-body{padding:16px 20px 16px}
.gb-name{font-size:22px;line-height:28px;font-weight:500;margin-bottom:6px}
.gb-body .ph-row{font-size:14px;line-height:21px}
.gb-link{color:var(--cs-green);text-decoration:underline;text-underline-offset:2px}
.gb-btn{margin-top:12px;height:32px;padding:0 12px;border-radius:16px;background:var(--cs-green-container);color:var(--cs-on-green-container);font-size:14px;font-weight:500}
.gb-media{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:109px 109px;gap:4px;margin-top:16px;border-radius:14px;overflow:hidden}
.gb-media>div{background-size:cover;background-position:center;display:grid;place-items:center}
.gb-media .m1{grid-row:1/3;position:relative}
.gb-media .m1>span{position:absolute;left:10px;top:10px;height:24px;padding:0 8px 0 6px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px}
.gb-rows{border-top:1px solid var(--cs-divider);padding:8px 0}
.gb-rows .irow{padding:8px 20px;gap:20px}
.stars{position:relative;display:inline-block;font-size:14px;letter-spacing:.5px;color:#dadce0;line-height:1;margin:0 2px 0 4px;top:-1px}
.stars::before{content:"★★★★★";position:absolute;left:0;top:0;width:calc(var(--v) / 5 * 100%);overflow:hidden;color:var(--cs-star)}
.open{color:var(--cs-up)}
```
Content: header `Demo shop · fictional business` + `info` · name · rating `4.5 ★★★★★ (312)` · `Kebab shop · ££` · `Open · Closes 2 am` · `.gb-btn` `Open in Maps` · 3-photo collage (Unsplash) with `photo_library 8 photos` badge · rows `location_on` address, `schedule` hours + `expand_more`, `public` website, `call` phone (all fictional `.example` / `020 7946 0xxx` data).

## 10. Rail panels: Live, Top shops, Launched, My coins

Rail panels open in the same `.panel` container as a place (desktop/tablet side panel; mobile bottom sheet at Half, opened from the drawer). Opening one sets `body.panel-open` + `body.live-on` (hides "This area"), marks its rail item active, and hides the rail place entry. Content starts with `padding-top:76px` on desktop/tablet so the floating search pill never covers it (mobile: 8px, the sheet has a handle instead).

### 10.1 Shared list CSS (from the mock, verbatim)
```css
.lp-h{display:flex;align-items:flex-end;justify-content:space-between;padding:76px 24px 8px}
.lp-h h1{margin:0;font-size:22px;line-height:28px;font-weight:600}
.lp-tabs{display:flex;gap:8px;padding:8px 24px 8px;overflow-x:auto}
.lp-tabs button{height:32px;padding:0 14px;border-radius:16px;border:1px solid var(--cs-outline-2);font-size:13px;font-weight:600;color:var(--cs-text-2)}
.lp-tabs button.on{background:var(--cs-green-container);border-color:transparent;color:var(--cs-on-green-container)}
.feed{padding:4px 0}
.frow{display:flex;align-items:center;gap:12px;padding:10px 24px;min-height:60px;cursor:pointer}
.frow:hover{background:var(--cs-state-hover)}
.frow .av{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:20px;flex:none;position:relative}
.frow .av i{position:absolute;right:-2px;bottom:-2px;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;color:#fff;box-shadow:0 0 0 2px #fff;font-style:normal}
.frow .av i .ms{font-size:12px;font-variation-settings:'FILL' 1,'wght' 700,'GRAD' 0,'opsz' 20}
.frow .tx{flex:1;min-width:0}
.frow .tx b{font-weight:600}
.frow .t1{font-size:14px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.frow .t2{font-size:12px;line-height:16px;color:var(--cs-text-2)}
.frow .rt{text-align:right;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.frow .rt small{display:block;font-size:11px;font-weight:400;color:var(--cs-text-3)}
.frow.new{animation:rowin .6s var(--cs-ease-decel)}
@keyframes rowin{from{background:var(--cs-green-tint)}to{background:transparent}}
.rank{width:20px;font-size:13px;font-weight:700;color:var(--cs-text-3);text-align:center;flex:none}
```
Mobile: `.lp-h{padding:8px 16px 8px}`, `.lp-tabs,.frow{padding-left:16px;padding-right:16px}`. Every `.frow` is a `<button>` (full row) and opens the coin (§18). Rows only ever show **our** data: `$TICKER`, coin name, launcher-picked category, on-chain numbers. Never Google names, ratings, addresses or photos.

**Back to list.** When a place is opened from a rail panel, a back chip appears in the place panel at `left:16px; top:72px` of the card (desktop/tablet; mobile: left of the title row): white pill 32h, `padding:0 12px 0 8px`, `--cs-elev-1`, `arrow_back` 18px + panel name (`Live`, `Top shops`, `Launched`, `My coins`). It restores the list with its scroll position.

### 10.2 Live
- Header: h1 `Live` + `.area-live` indicator `simulated · updating` (production: `updating`).
- Filter tabs (`.lp-tabs`, single-select): `All` · `Trades` · `Launches` · `Claims`.
- Feed rows (newest first, max 100 kept; new rows animate `.frow.new`):

| Event | Avatar badge (`.av i`) | t1 | t2 | Right (`.rt` + `small`) |
|---|---|---|---|---|
| Buy | `arrow_upward` on `--cs-up` | `<b>$PEPI</b> · Nonna Pepi's Pizza` | mono 11px `3cHq…91aB` + ` bought` | `.up` `1.2 SOL` / `12s ago` |
| Sell | `arrow_downward` on `--cs-down` | same | `… sold` | `.down` `2.5 SOL` / `48s ago` |
| Launch | `rocket_launch` on `--cs-green` | same | `… launched · first launch wins` | `New` / `1m ago` |
| Claim | `payments` on `--cs-amber-bright` | same | `… claimed fees` | `$412` / `3m ago` |

- Below the feed: `.sec-title` `Top shops` + `.seg` `Market cap` | `Fees earned`, then the top 5 rows (§10.3 row format) and a `.btn-text` `See all top shops` that opens the Top shops panel.
- Pause: when the browser tab is hidden, stop inserting rows; on return insert a single `.frow`-styled button `12 new events · Show` at the top.

### 10.3 Top shops
- Header: h1 `Top shops`; right side `.seg` `Market cap` (default) | `Fees earned`.
- Scope chips (`.lp-tabs` style): `Everywhere` (default) · `This area` (coins inside the current map bounds).
- Rows (top 50): `.rank` 1–50 · `.av` emoji on `--bg` · t1 `<b>$KEBAB</b> · Bosphorus Grill` (+ 16px `verified` FILL green icon after the ticker if claimed) · t2 `Kebab shop · <span class="amb" style="font-weight:600">$1,240</span> fees` · rt `$212k` / `small` `▲ 12.4%`.
- With `Fees earned` selected: sorted by fees; t2 becomes `Kebab shop · $212k mcap`; rt becomes `.amb` `$1,240` / `small` `≈ 8.27 SOL`.
- Empty (This area with no coins): §13.4.

### 10.4 Launched
- Header: h1 `Launched` + caption `Newest first`.
- Rows: `.av` (with `rocket_launch` badge for coins launched in the last hour) · t1 `<b>$CRUMB</b> · Crumb & Co. Bakery` · t2 `Bakery · launched by 7xKX…3pQa` (`by you` if it's yours) · rt `$8.1k` / `1m ago`.
- Opening this panel sets `cs_launched_seen_at = now` (clears the rail badge).

### 10.5 My coins
- Disconnected: empty state (§13.4) with a `.btn-primary` `account_balance_wallet` `Connect wallet`.
- Connected: header h1 `My coins` + caption `2.41 SOL · $361` (demo balance). Sections (each a `.sec-h` + rows; empty sections are omitted):
  - `Your shops` (claimed by this wallet): rt `.amb` `$1,240` / `available`; a `.btn-tonal` 32h `Payout settings` in the row's trailing slot on desktop.
  - `Holding`: rt `$84.20` / `▲ 12.4%` (value of holdings in USD, 24h change).
  - `Launched by you`: rt `$8.1k` / `mcap`.
- All empty: empty state `No coins yet` + buttons `Find a shop` (closes the panel, focuses the map) and `Launch a coin` (focuses search with the link tip open).

## 11. First-visit hero card

Shown on the first visit (`localStorage.cs_hero_seen` absent; read and write inside try/catch. If storage throws, show it once per page session). Copy is **verbatim from BRIEF.md, lowercase**.

```css
.herocard{display:none;position:fixed;left:88px;top:72px;width:440px;background:#fff;border-radius:var(--cs-r-2xl);box-shadow:var(--cs-elev-3);z-index:var(--z-float);padding:24px 24px 20px;overflow:hidden}
body.hero-on .herocard{display:block}
.herocard .close{position:absolute;right:12px;top:12px;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;color:var(--cs-icon)}
.herocard .close:hover{background:var(--cs-state-hover)}
.brand{display:flex;align-items:center;gap:10px}
.brand .app-icon{width:32px;height:32px;border-radius:10px}
.brand .app-icon svg{width:20px;height:20px}
.wordmark{font-size:16px;line-height:20px;font-weight:800;font-stretch:120%;letter-spacing:.6px;color:var(--cs-text)}
.herocard h1{margin:18px 0 0;font-size:32px;line-height:38px;font-weight:750;letter-spacing:-.6px;font-variation-settings:'opsz' 40}
.herocard h1 span{color:var(--cs-green)}
.herocard p{margin:10px 0 0;font-size:16px;line-height:24px;color:var(--cs-text-2);letter-spacing:.1px}
.herocard p b{color:var(--cs-text);font-weight:600}
.paste{margin-top:20px;display:flex;align-items:center;gap:8px;height:56px;border-radius:28px;background:var(--cs-surface-2);padding:0 6px 0 18px;border:1px solid transparent}
.paste:focus-within{background:#fff;border-color:var(--cs-green);box-shadow:0 0 0 1px var(--cs-green)}
.paste .ms{color:var(--cs-icon);font-size:22px}
.paste input{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:15px}
.paste input::placeholder{color:var(--cs-text-2)}
.paste .btn{height:44px;border-radius:22px;padding:0 22px;font-size:15px}
.hero-or{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:12px;line-height:16px;color:var(--cs-text-2);flex-wrap:wrap}
.hero-or .chip{height:28px;font-size:12px;padding:0 10px 0 8px;box-shadow:none;border:1px solid var(--cs-outline-2)}
.hero-stats{display:flex;gap:0;margin:20px -24px -20px;border-top:1px solid var(--cs-divider);background:var(--cs-rail)}
.hero-stats div{flex:1;padding:12px 16px 14px 24px}
.hero-stats div+div{border-left:1px solid var(--cs-divider);padding-left:16px}
.hero-stats b{display:block;font-size:18px;line-height:24px;font-weight:700;font-variant-numeric:tabular-nums}
.hero-stats b.amb{color:var(--cs-amber)}
.hero-stats small{font-size:12px;line-height:16px;color:var(--cs-text-2)}
/* mobile (<768): hero becomes a bottom sheet */
.herocard{left:0;right:0;top:auto;bottom:0;width:auto;border-radius:var(--cs-r-2xl) var(--cs-r-2xl) 0 0;box-shadow:var(--cs-elev-sheet);padding:28px 20px 20px;max-height:calc(100dvh - 140px);overflow:auto;z-index:var(--z-sheet)}
.herocard::before{content:"";position:absolute;left:50%;top:8px;width:32px;height:4px;margin-left:-16px;border-radius:2px;background:#c4c7c5}
.herocard h1{font-size:28px;line-height:34px}
.herocard p{font-size:15px;line-height:22px}
.hero-stats{margin:18px -20px -20px}
.hero-stats div{padding-left:20px}
body.hero-on #mapwrap{bottom:calc(100dvh - 330px)}
body.hero-on .m-fab.locate-fab{display:none}
```
Content, top to bottom (exact strings):
1. Close button (`close`, `aria-label="Dismiss"`).
2. Brand: app icon 32 + wordmark `CORNERSHOP`.
3. h1: `your cafe. your barber. ` + `<span>your kebab shop.</span>` (the last sentence green).
4. p: `launch a coin for any business on earth. ` + `<b>100% of creator fees are held for the shop's verified owner.</b>`
5. p (`margin-top:6px`): `paste a google maps link. launch. done.`
6. Paste form: `link` icon · input placeholder `paste a google maps link` (`aria-label="Paste a Google Maps link"`) · `.btn-primary` `try now` (type submit).
7. `.hero-or`: `or tap any shop on the map` + chip `🔥 Live coins` + chip `near_me Near me` (both `<button>`s).
8. `.hero-stats` (live numbers, non-interactive): `128` `shops launched` · `.amb` `$18.4k` `waiting for owners` · `0%` `platform cut of fees`.

States: idle · focused (paste field white with green border) · resolving (`try now` shows spinner, input read-only) · error (12/16 `--cs-down` line under the form, `margin:8px 0 0 18px`: `That doesn't look like a Google Maps link.` or `Couldn't find that place. Copy the link from Share in Google Maps.`) · dismissed (sets `cs_hero_seen=1`). While the hero is on: "This area" hidden; on mobile the map is 330px tall and the locate FAB hidden. Mobile: dragging the handle down > 80px dismisses.

## 12. Modals

### 12.1 Dialog shell (from the mock, verbatim) + additions
```css
.scrim{position:fixed;inset:0;background:var(--cs-scrim);z-index:var(--z-scrim)}
.dialog{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 48px);overflow:auto;background:#fff;border-radius:var(--cs-r-2xl);box-shadow:var(--cs-elev-3);z-index:var(--z-modal);padding:20px 24px 20px}
.dlg-h{display:flex;align-items:center;justify-content:space-between;margin:-4px -8px 8px 0}
.stepper{list-style:none;margin:0;padding:0;display:flex;gap:6px;counter-reset:st}
.stepper li{counter-increment:st;display:flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 4px;border-radius:14px;font-size:12px;font-weight:600;color:var(--cs-text-3);background:var(--cs-surface-2)}
.stepper li::before{content:counter(st);width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:#fff;color:var(--cs-text-2);font-size:11px}
.stepper li.on{background:var(--cs-green-container);color:var(--cs-on-green-container)}
.stepper li.on::before{background:var(--cs-green);color:#fff}
.dialog h2{margin:8px 0 0;font-size:22px;line-height:28px;font-weight:600}
.dlg-sub{margin:6px 0 0;font-size:14px;line-height:20px;color:var(--cs-text-2)}
.art-row{display:flex;gap:16px;align-items:center;margin-top:20px}
.art{width:80px;height:80px;border-radius:50%;border:2px dashed var(--cs-outline);display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--cs-text-2);flex:none;background:var(--cs-surface-2)}
.art small{font-size:11px;font-weight:600;margin-top:2px}
.lbl2{font-size:12px;color:var(--cs-text-2)}
.emoji-pick div{display:flex;gap:6px;margin-top:6px}
.emoji-pick button{width:40px;height:40px;border-radius:12px;font-size:20px;border:1px solid var(--cs-outline-2)}
.emoji-pick button.on{border:2px solid var(--cs-green);background:var(--cs-green-tint)}
.tf{position:relative;display:flex;align-items:center;height:56px;border:1px solid var(--cs-outline);border-radius:12px;padding:0 14px 0 16px;margin-top:16px;gap:4px}
.tf:focus-within{border:2px solid var(--cs-green);padding-left:15px}
.tf input{flex:1;min-width:0;border:0;outline:0;font-size:16px;background:transparent}
.tf-l{position:absolute;left:12px;top:-9px;padding:0 4px;background:#fff;font-size:12px;line-height:16px;color:var(--cs-text-2)}
.tf:focus-within .tf-l{color:var(--cs-green)}
.tf-pre{font-size:16px;color:var(--cs-text-2);font-weight:600}
.tf-c{font-size:12px;color:var(--cs-text-3)}
.tf-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dlg-box{display:flex;gap:12px;margin-top:16px;padding:12px 14px;border-radius:12px;background:var(--cs-amber-container);color:var(--cs-on-amber-container);font-size:13px;line-height:18px}
.dlg-box b{display:block;font-weight:600}
.dlg-box small{display:block;font-size:12px;line-height:16px;color:#7d5426;margin-top:2px}
.dlg-buy{display:flex;align-items:center;justify-content:space-between;margin-top:16px;font-size:14px;color:var(--cs-text)}
.dlg-f{display:flex;align-items:center;gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--cs-divider)}

/* additions */
.stepper li.done{background:var(--cs-green-tint);color:var(--cs-on-green-container)}
.stepper li.done::before{content:"✓";background:var(--cs-green);color:#fff}
.tf.err{border:2px solid var(--cs-down);padding-left:15px}
.tf.err .tf-l{color:var(--cs-down)}
.tf-help{margin:4px 16px 0;font-size:12px;line-height:16px;color:var(--cs-text-2)}
.tf-help.err{color:var(--cs-down)} .tf-help.warn{color:var(--cs-amber)}
.tf select{flex:1;min-width:0;border:0;outline:0;font:inherit;font-size:16px;background:transparent;appearance:none}
.dlg-box.green{background:var(--cs-green-tint);color:var(--cs-on-green-container)}
.dlg-box.green small{color:var(--cs-text-2)}
.check{display:flex;gap:12px;align-items:flex-start;margin-top:16px;font-size:13px;line-height:18px;color:var(--cs-text)}
.check input{width:20px;height:20px;margin:0;accent-color:var(--cs-green);flex:none}
.opt{display:flex;align-items:center;gap:16px;width:100%;min-height:72px;padding:12px 16px;margin-top:8px;border:1px solid var(--cs-divider);border-radius:12px;text-align:left}
.opt:hover{background:var(--cs-state-hover)}
.opt[aria-checked="true"]{border:2px solid var(--cs-green);padding:11px 15px;background:var(--cs-green-tint)}
.opt .oi{width:40px;height:40px;border-radius:50%;background:var(--cs-green-container);color:var(--cs-on-green-container);display:grid;place-items:center;flex:none}
.opt b{display:block;font-size:14px;line-height:20px;font-weight:600}
.opt small{display:block;font-size:12px;line-height:16px;color:var(--cs-text-2)}
.code6{display:flex;gap:8px;justify-content:center;margin-top:20px}
.code6 input{width:48px;height:56px;border:1px solid var(--cs-outline);border-radius:12px;text-align:center;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;outline:0}
.code6 input:focus{border:2px solid var(--cs-green)}
.code6.err input{border:2px solid var(--cs-down)}
.dlg-center{text-align:center;padding:12px 0 4px}
.dlg-center .big{width:96px;height:96px;margin:8px auto 0;border-radius:50%;display:grid;place-items:center}
```
**Shell behaviour (all modals):** `role="dialog" aria-modal="true" aria-labelledby=<h2 id>`; focus moves to the first field (or the primary button) on open and returns to the opener on close; Tab is trapped; Esc and scrim click close **unless** the modal is in a busy step (Launching, Calling) where both are ignored; body scroll is already locked by the app. Header = `.stepper` (left; omitted in single-step modals) + `.icon-btn` `close` (`aria-label="Close"`). Footer `.dlg-f` = `.demo-note` (left) · spacer · secondary `.btn-text` · primary `.btn-primary`.
**Mobile (<768):** the dialog becomes a bottom sheet: `left:0; right:0; bottom:0; top:auto; transform:none; width:auto; max-width:none; max-height:calc(100dvh - 24px); border-radius:28px 28px 0 0; padding:20px 16px calc(16px + env(safe-area-inset-bottom))`, with the grab handle bar from §8.3, and `.dlg-f` is `position:sticky; bottom:0; background:#fff`. `.tf-row` stacks to one column below 400px. `.code6 input` is 44×52.

### 12.2 Launch modal — Details → Sign in → Review → Launching → Success
Stepper labels: `Details` · `Sign in` · `Review` · `Launch` (Launching and Success are both step 4). Opened from: the Launch action/pill, the launchable pin label, the search link row `Launch`, a search Places row `Launch`, the hero `try now` (with a link that resolves to an unlaunched place), and the search pill's rocket button (with a place selected; with none selected it focuses search and shows the link tip).

**Step 1 — Details** (the mock's `?state=launch`)
- h2 `Launch a coin for Crumb & Co. Bakery` (the place's `displayName` from one `Place.fetchFields(['displayName'])` call, shown only, never stored; fallback `Launch a coin for this shop`).
- `.dlg-sub` `One coin per place — first launch wins. You can't change the name or ticker later.`
- `.art-row`: `.art` button (`add_photo_alternate` + `Coin art`) → file picker (PNG, JPG, WebP, GIF ≤ 2 MB; centre-crop to square; preview fills the 80px circle and the dashed border disappears; a 24px `close` badge at top-right removes it). Next to it `.emoji-pick` `or pick a sticker` with 6 stickers chosen by category (Bakery: 🥐 🍞 🧁 🥖 ☕ 🍩; Café: ☕ 🥐 🍰 🧋 🫖 🍪; Barber: 💈 ✂️ 🪒 💇 🧔 💅; Kebab: 🥙 🌯 🍢 🔥 🧆 🥗; Pizza: 🍕 🧀 🍅 🌶️ 🫓 🍷; Pub: 🍺 🍻 🍷 🎯 🥃 🍟; Corner shop: 🏪 🥤 🍫 🧃 🗞️ 🍬; Other: 🏪 ⭐ 💚 🛍️ 🔑 🎉). Selected sticker `.on`. Upload and sticker are mutually exclusive; one is required (default: first sticker).
- Under the stickers: `Colour` (`.lbl2`) + 6 swatches, 24px circles, gap 8 (selected: `box-shadow:0 0 0 2px #fff,0 0 0 4px var(--cs-green)`): `#ffe4cc` `#efe3d6` `#e3e8ff` `#ffe0db` `#fff1c7` `#dff3e6`. This is the coin's `--bg` (pin face, avatars, sticker hero).
- `.tf` `Coin name` (prefilled from `displayName`, editable, max 32, counter `18/32`).
- `.tf-row`: `.tf` `Ticker` with `.tf-pre` `$` (prefill: first word of the name, letters/digits only, uppercased, max 8; input forces uppercase; counter `5/8`) · `.tf` `Category` (native `<select>` + `arrow_drop_down`; options `Café`, `Barber shop`, `Kebab shop`, `Pizza`, `Bakery`, `Pub`, `Corner shop`, `Restaurant`, `Other`; prefilled from the Google primary type when it maps, else `Other`).
- `.dlg-box` (amber) `payments` FILL: `<b>100% of creator fees → held for this shop</b><small>Unclaimed · not affiliated with this business. The owner claims by phone verification.</small>`
- `.dlg-buy`: `First buy (optional)` + `.seg` `None` · `0.1 SOL` (default) · `0.5` · `1`.
- Footer: `Demo — no real transaction` · `Cancel` · `Continue`.
- Validation (on blur and on Continue): name empty → `.tf.err` + `.tf-help.err` `Give your coin a name`; ticker not `^[A-Z0-9]{2,8}$` → `Ticker must be 2–8 letters or numbers`; ticker used by another coin → `.tf-help.warn` `$CRUMB is already used by another shop. You can still use it.` (not blocking). `Continue` is disabled while there are errors.

**Step 2 — Sign in** (skipped and shown as `.done` when a wallet is already connected)
- h2 `Sign in to launch`; sub `You'll be listed as the launcher. In the demo nothing is signed or sent.`; then the wallet list and `Continue with email` from §12.4, embedded. A successful connect advances to Review automatically. Footer: `Back` · (no primary).

**Step 3 — Review**
- h2 `Review your coin`; sub `The name and ticker are permanent.`
- Summary card (border 1px `--cs-divider`, radius 16, padding 16, flex gap 16): 56px coin avatar (art, or sticker 28px on `--bg`) · `.ticker.ghost` `$CRUMB` · name 16/22 600 `Crumb & Co. Bakery` · `Bakery` 12/16 text-2.
- `Place` (`.lbl2`, margin-top 16) + the **compact Google element** for this place ID (§9.5).
- `.dlg-box.green` with `rocket_launch` icon, single line, exact text: **`Launchpad: pump.fun · Creator fees → this shop's vault (100%)`**.
- Detail rows (14/20, 36px each, label `--cs-text-2` left, value 600 right): `Network` `Solana` · `First buy` `0.1 SOL` (or `None`) · `Platform cut` `0%` · `Network fee` `~0.02 SOL (simulated)`.
- `.check` (required): `I understand this coin isn't affiliated with the business and anyone can trade it.`
- Footer: `Demo — no real transaction` · `Back` · `.btn-primary` `rocket_launch` `Launch $CRUMB` (disabled until checked).

**Step 4a — Launching** (busy: close, Esc and scrim do nothing)
- h2 `Launching $CRUMB…`; three rows (40px, gap 12, 14/20): leading 20px icon = `progress_activity` (spinning, `--cs-green`) while running, then `check_circle` FILL `--cs-green` when done; pending rows `--cs-text-3`. Rows: `Creating the coin on pump.fun` → `Pointing creator fees to the shop's vault` → `Putting it on the map`. About 1s each (simulated). `.demo-note` below.

**Step 4b — Success**
- `.dlg-center`: `.big` 96px coin avatar (art or sticker 48px on `--bg`) with a single green ring burst (§14); h2 `$CRUMB is live`; sub `You launched the first coin for this shop. Every trade now builds fees for the owner.`; if a first buy was made: 12/16 text-2 `First buy: 0.1 SOL → 2.36M $CRUMB`.
- Buttons (stacked, full width on mobile; inline centred on desktop, gap 8): `.btn-primary` X glyph + `Share on X` · `.btn-outline` `View coin`.
- Below: 12/16 text-2 `Know the owner? Send them this page so they can claim the fees.` + `.btn-text` `link` `Copy link`.
- On close (any way) the panel shows the Launched variant, the new pin pops in and is selected, the live feed gets a Launch row, and the rail badge does not count your own launch.

**Errors**

| Case | Screen |
|---|---|
| Someone launched this place first (on Continue or on Launch) | `.dlg-center`: 64px `warning` on `--cs-amber-container`; h2 `Someone launched this shop first`; sub `This place now has $BREAD. One coin per place.`; buttons `View $BREAD` (primary) · `Close` |
| Launch failed | 64px `error` on `--cs-down-bg` (icon `--cs-down`); h2 `Launch failed`; sub `Nothing was sent. You can try again.`; buttons `Try again` (re-runs 4a) · `Back to review` |
| Upload too big / wrong type | `.tf-help.err` under the art row: `Use a PNG, JPG, WebP or GIF under 2 MB.` |
| Wallet disconnected mid-flow | Jump to step 2 with `.tf-help.err` `Your wallet disconnected. Sign in again to continue.` |

### 12.3 Claim modal — phone-call verification
Stepper: `Verify` · `Code` · `Payout` · `Done`. Opened from: `I own this business` (fees card / fee mini), the `Claim` action/pill, `Payout settings` (opens directly at Payout for the current owner). The **server** looks up the listing's phone number from Google with the server key; the client only ever receives a masked number. Prototype: everything is simulated and the footer note reads `Demo — no real call is made`.

**Step 1 — Verify**
- h2 `Claim fees for this shop`; sub `We'll call the phone number on this shop's Google listing and read out a 6-digit code.`
- Compact Google element for the place (§9.5).
- Number card (margin-top 16, radius 12, `--cs-surface-2`, padding 12 16, flex gap 12): `call` 20px `--cs-green` · `Listed number` (12/16 text-2) over `+44 20 •••• ••23` (16/22 600 tabular). Mask format: country code + first 2 national digits + `•` for the rest, except the last 2.
- 12/16 text-2: `We look this number up on Google ourselves. It can't be changed here.`
- Turnstile widget slot (production): 300×65, centred, margin-top 16. The primary button is disabled until the token arrives. The prototype renders no widget and no placeholder.
- If fees are waiting: `.dlg-box` amber `payments` `<b>$1,240 waiting for this shop</b><small>≈ 8.27 SOL · paid to the wallet you choose next</small>`.
- Footer: `Demo — no real call is made` · `.btn-text` `Can't answer this number?` (→ Other ways) · `.btn-primary` `phone_in_talk` `Call me with a code`.

| Blocking case | Banner that replaces the number card (amber `.dlg-box`, `warning` icon). The primary becomes `See other ways` unless noted |
|---|---|
| Listing has no phone | `This listing has no phone number. Choose another way to verify.` |
| Premium / unsupported number | `We can't call this number. Choose another way to verify.` |
| Another claim is active | `Someone is verifying this shop right now. Try again in 10 minutes.` (primary disabled, no fallback) |
| Rate limited (place, IP or wallet) | `Too many attempts. Try again in 1 hour.` (primary disabled) |
| Already claimed | h2 `This shop is already claimed`; sub `If that's wrong, tell us and we'll review it.`; buttons `Report a problem` · `Close` |

**Step 2 — Code** (busy while "Calling…": close/Esc ignored for 3s only)
- h2 `Enter the code`; sub `We're calling +44 20 •••• ••23 now. Answer and listen for 6 digits.`
- Call status row (centred, margin-top 16): 40px `--cs-green-container` circle with `phone_in_talk` + the ping ring (§14) + 14/20 `Calling…` → after 3s `Call placed · code expires in 10 minutes`.
- Prototype only: `.dlg-box` amber `info` `<b>Demo code: 482 913</b><small>No call is made in the demo.</small>`.
- `.code6`: 6 inputs, `inputmode="numeric" autocomplete="one-time-code"`, `aria-label="Digit 1 of 6"` etc. Typing advances, Backspace goes back, pasting 6 digits fills all. Auto-submits on the 6th digit (button spinner `Checking…`).
- Wrong code: `.code6.err` + shake (§14) + `.tf-help.err` centred `That code didn't match. 2 tries left.`; after 3 wrong codes: `Too many wrong codes. Request a new call.` and the inputs disable.
- Below (centred): `.btn-text` `Call me again` — disabled with label `Call again in 45 s` during a 45s cooldown — and `.btn-text` `Use another way`.
- Footer: demo note · `Back` · `.btn-primary` `Verify` (enabled when 6 digits are entered).

**Step 3 — Payout**
- If no wallet is connected: h2 `Sign in to get paid` + the embedded wallet list (§12.4); on connect, continue here.
- h2 `Where should the fees go?`; sub `Fees for $KEBAB are paid to this Solana wallet.`
- Two `.opt` radio cards (`role="radio"`): (1) `account_balance_wallet` `Connected wallet` / `7xKX…3pQa` (default); (2) `edit` `Another address` → reveals `.tf` `Solana address` (mono 14px; validate base58, 32–44 chars; error `That isn't a valid Solana address`).
- `.dlg-box` amber `schedule`: `<b>72-hour hold on the first payout</b><small>So a hijacked listing can be disputed before any money moves.</small>`
- `.check` (required): `I'm the owner of this business, or authorised by the owner.`
- Footer: demo note · `Back` · `.btn-primary` `Claim $1,240` (or `Claim this shop` when $0).

**Step 4 — Done**
- `.dlg-center`: `.big` 96px `--cs-green-container` with `verified` FILL 48px `--cs-green`; h2 `You've claimed this shop`; sub `$1,240 (≈ 8.27 SOL) will be paid to 7xKX…3pQa after the 72-hour hold. New fees follow automatically.` + `.demo-note`.
- Buttons: `.btn-outline` `ios_share` `Share that you're verified` (opens Share, owner variant) · `.btn-primary` `Done`.
- After close: header line → `You own this shop · fees go to 7xKX…3pQa`; fees card → owner state; pin gets the verified tick; Live feed gets a Claim row.

**Other ways to verify** (a sub-screen, reachable from steps 1 and 2; the stepper stays on `Verify`)
- h2 `Other ways to verify`; sub `These take longer than a call.` + `.btn-text` `arrow_back` `Back to phone call` above the h2.
- Three `.opt` cards (chevron trailing):
  1. `language` `Code on your website` / `Add a short code to a page on bosphorusgrill.example. We check it automatically.` (host from the Google listing, fetched by the server, display only). Disabled with sub `This listing has no website` when absent.
  2. `mail` `Email at your website's domain` / `We'll send a link to an address @bosphorusgrill.example.` (disabled when no website).
  3. `support_agent` `Manual review` / `Post a code on the shop's socials, or send a photo of it in the shop. Takes 1–3 days.`
- Website sub-screen: code box (`--cs-surface-2`, radius 12, padding 12 16, mono 18px 600 `atlaspad-verify=7KQ2-M9XD` + `content_copy` icon button); 14/20 `Add this text anywhere on bosphorusgrill.example, then press Check.`; primary `Check my website` (spinner `Checking…`; success → Payout; fail → `.tf-help.err` `We couldn't find the code yet. It can take a few minutes after you publish.`).
- Email sub-screen: `.tf` `Email` with a fixed suffix `@bosphorusgrill.example` (`.tf-c` style, 16px); primary `Send link` → `Check your inbox` screen with `Resend in 45 s`; prototype adds a `.btn-tonal` `Demo: open the link` that advances to Payout.
- Manual sub-screen: big code `CS-7KQ2` (mono 28px 700, centred); 14/20 `Post this code on the shop's Instagram, Facebook or X, or take a photo of it on paper inside the shop.`; `.tf` `Link to the post`; `.btn-outline` `photo_camera` `Add a photo` (image picker ≤ 5 MB); primary `Submit for review` (enabled when a link or photo is present) → Done variant: h2 `We'll review your claim`, sub `Usually within 3 days. We'll show "Owner verification in progress" on the shop until then.`, button `Done`.

### 12.4 Wallet / sign-in modal (Solana)
Single step, width 420px (mobile: sheet). Opened from: `Connect wallet` pill, mobile `.wallet-mini`, any action that needs a wallet (Buy, Sell, Watch, Launch step 2, Claim step 3, My coins). If opened by an action, that action continues after connecting.
- h2 `Connect`; sub `Sign in to launch, trade and claim.`
- **Wallet list** (margin-top 16): wallets discovered through **Wallet Standard** (`getWallets()` from `@wallet-standard/app`), filtered to wallets with `standard:connect` and the `solana:mainnet` chain. Pinned first, in this order: **Phantom**, **Solflare**, **Backpack**; then any other detected Solana wallets alphabetically.
  - Row: `<button>` 56px, padding 0 12, radius 12, gap 12, hover `--cs-surface-2`: 32px icon (`wallet.icon` data URI, radius 8) · name 15/20 500 · trailing 12/16 `--cs-text-3` `Detected`.
  - Pinned wallet not installed: same row, trailing `.btn-text` `Install` + `open_in_new` → `https://phantom.com/download`, `https://solflare.com/download`, `https://backpack.app/downloads`. On mobile without an injected wallet the trailing action is `Open in app` → Phantom `https://phantom.app/ul/browse/<encoded url>?ref=<encoded origin>`, Solflare `https://solflare.com/ul/v1/browse/<encoded url>?ref=<encoded origin>`; Backpack shows `Install`.
  - Connecting: the row shows a spinner and the trailing text `Approve in Phantom…`; other rows are disabled.
  - Rejected / error: row inline `.tf-help.err` `Request cancelled in Phantom` (or `Phantom isn't responding. Try again.`); rows re-enable.
- Divider: 1px lines with centred `or` (12/16 text-3), margin 16 0.
- `.btn-outline.btn-block` `mail` `Continue with email` → email screen: `.btn-text` `arrow_back` `Back`; h2 `Continue with email`; `.tf` `Email` (type email, autocomplete email); primary `Send code` → code screen: sub `We sent a 6-digit code to sam@…com`, `.code6`, `Resend in 45 s`, primary `Verify`. Prototype: a demo box shows `Demo code: 271 604`; success creates a mocked embedded wallet with a generated base58 address.
- Footer (12/16 text-2, centred): `By continuing you agree to the Terms and Privacy Policy. We never ask you to sign anything in the demo.` (`Terms`, `Privacy Policy` are links).
- Only `standard:connect` (and `standard:disconnect`, `standard:events`) are ever called. Never `solana:signMessage`, `solana:signTransaction`, `solana:signAndSendTransaction`.
- Success: modal closes, toast `Connected · 7xKX…3pQa`, wallet pill switches to connected (§6.4). Remember the wallet name in localStorage `cs_wallet` (try/catch) and silently reconnect (`silent` / `onlyIfTrusted` where the wallet supports it) on the next visit.

### 12.5 Share modal + 1200×675 share card
Single step, width 520px. Opened from Share (action, pill, mobile `.ph-x`), launch Success (via `Share on X` it skips the modal and opens X directly), claim Done.
- h2 `Share $KEBAB` (launchable: `Share this shop`).
- Card preview: the 1200×675 PNG at width 100% (472px → 265.5px tall), radius 12, 1px `--cs-divider` border. While generating: skeleton block of the same size.
- `.tf` multi-line (`<textarea>` 3 rows, label `Post`), prefilled per variant (§16.9), editable; counter `118/280`.
- Buttons row (wrap, gap 8): `.btn-primary` X glyph + `Post on X` → opens `https://x.com/intent/post?text=<encoded text>&url=<encoded share url>` in a new tab · `.btn-outline` `link` `Copy link` · `.btn-outline` `download` `Download image` (saves `cornershop-KEBAB.png`) · mobile only, when `navigator.share` exists: `.btn-outline` `ios_share` `More`.
- X glyph: inline SVG 18px, `fill:currentColor`, path `M18.9 1.2h3.7l-8 9.1L24 22.8h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9 6.1-6.9zm-1.3 19.4h2L6.5 3.3H4.3l13.3 17.3z` (viewBox `0 0 24 24`).
- Share URLs: coin `https://cornershop.tiejiucai.workers.dev/c/<coinId>`, place `https://cornershop.tiejiucai.workers.dev/p/<placeId>`. Both serve OG/Twitter meta (`twitter:card=summary_large_image`) pointing at `/api/og/c/<coinId>.png` / `/api/og/p/<placeId>.png`.

**Share card (1200×675 PNG, server-rendered from an SVG template with Roboto Flex embedded)**
```
┌──────────────────────────────────────────────────────────────── 1200 ┐
│ ░ our own street pattern on #e8e6e1 (never Google tiles) ░  [● DEMO · simulated prices] │ 48px from top/right
│   ┌──────────┐                                                        │
│   │  coin    │   $KEBAB                      ← 120/120 800, stretch 110%, #0e7c47
│   │  art or  │   Bosphorus Grill             ← 44/52 600, #1f1f1f  (coin name, launcher-typed)
│   │ sticker  │   ▲ 12.4% · $212k mcap        ← 36/44 600, up/down colour + #5e5e5e
│   │  280px ◉ │   ( 💰 $1,240 waiting for this shop )  ← pill 72h r36 #ffedd0, 30px 700 #6b3a00
│   └──────────┘                                                        │
├──────────────────────────────────────────────────────────────────────┤ 96px white band
│ [app icon 48] CORNERSHOP                     cornershop.tiejiucai.workers.dev │ wordmark 28px 800 stretch 120% · URL 24px #5e5e5e
└──────────────────────────────────────────────────────────────────────┘ 675
```
- Background: `#e8e6e1` + white "streets" (three 22px and four 12px white bands at 20°, 115°, 160°, like the Layers tile) + three faint 24px green dots `rgba(21,163,90,.35)`. No map tiles, no Google content of any kind.
- Coin avatar: 280px circle at `x:96; y:150`, 12px white ring, shadow `0 12px 32px rgba(0,0,0,.18)`; art cover-fit, or the sticker at 150px on `--bg`. A 64×86 green balloon pin (§7.1 path) sits at its bottom-right.
- Text column starts at `x:448`, max width 680, vertically centred in the 579px area above the band; ticker shrinks to fit (min 88px).
- Variants: **claimed** — a 56px green `verified` badge after the ticker, and the pill becomes `--cs-green-container` / `--cs-on-green-container` `Claimed by the owner`; **launchable** — dashed white coin with a green rocket, headline `No coin yet` (100px 800 green), line `First launch wins.`, pill `100% of creator fees held for the shop`; **launch success** — the pill reads `Just launched`.
- The DEMO chip (amber, 40h, 24px 700) is on every card in the prototype.

### 12.6 Small sheets & popovers (single-purpose; same shell, no stepper)

| Name | Opened from | Content |
|---|---|---|
| DEMO explainer | DEMO chip | h2 `This is a demo`; body `Prices, trades, launches and claims are simulated. No real transaction is ever sent and you're never asked to sign anything. Real shops on the map are real Google places; the seeded coins are fictional.`; button `Got it` |
| Unclaimed info popover | `info` button in `.ph-unclaimed` | 280px popover (radius 12, `--cs-elev-2`, padding 12 16, 13/18): `Anyone can launch a coin for any shop. Until the owner verifies, the coin isn't affiliated with the business and all creator fees are held for them.` + link `How claiming works` (opens Help at "Claiming") |
| Owner popover | `Owner` action on a claimed shop | `Claimed by the owner on 2 Oct 2026. Fees go to the shop's wallet.` + `View payout wallet on Solscan` |
| Coin art lightbox | `.hero-btn` `Coin art`, mobile `.ph-img` | Scrim + centred image (max 90vw × 80vh, radius 16), credit line under it, `close` icon button top-right; Esc closes |
| Watch | `Watch` action (signed in) | No modal: toggles on with toast `We'll let you know when someone launches this shop.`; off: `Stopped watching this shop.` Watch list is kept per wallet (place IDs only) |
| Report | Footer `Report` | h2 `Report this coin`; radio `.opt`s `Pretends to be the business`, `Offensive name or art`, `Scam or misleading`, `Something else`; `.tf` `Details (optional)`; primary `Send report` → toast `Thanks — we'll review it. To follow up, email hello@atlaspad.online` + action `Copy email` |
| Business opt-out | Footer `Business opt-out`, drawer | h2 `Own this business?`; body `You can claim the fees, or ask us to hide coins for your business.`; buttons `Claim the fees` (→ claim modal) · `Ask us to hide it` → form (`.tf` `Your name`, `.tf` `Email at your business domain`, `.tf` `Anything we should know`) → `Send request` → toast `Request sent. We'll reply within 3 days from hello@atlaspad.online` + action `Copy email` |
| Help | Rail `Help`, drawer `Help` | Panel (not modal) with 4 expandable rows: `How launching works`, `Where the fees go`, `Claiming your shop`, `Is this real money?`; each answer 14/20; footer links `Terms` · `Privacy` · `Google Maps Terms` (https://maps.google.com/help/terms_maps/) · `Google Privacy` (https://policies.google.com/privacy) |

## 13. Feedback: toasts, tooltips, skeletons, empty & error states

### 13.1 Toasts
```css
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#1f1f1f;color:#fff;border-radius:8px;padding:12px 16px;font-size:14px;line-height:20px;box-shadow:var(--cs-elev-3);z-index:var(--z-toast);display:none;align-items:center;gap:12px}
/* mobile */ .toast{bottom:calc(var(--sheet-h) + 12px)}
/* additions */
.toast.show{display:flex}
.toast .ms{font-size:20px}
.toast .ms.ok{color:#7ad3a3} .toast .ms.bad{color:#ffb3b8}
.toast .act-t{margin-left:8px;color:#7ad3a3;font-weight:600;font-size:14px;height:36px;padding:0 8px;border-radius:18px}
.toast .act-t:hover{background:rgba(255,255,255,.08)}
```
- Max width `min(560px, calc(100vw - 32px))`; text wraps to 2 lines max. One toast at a time; a new one replaces the old (no stacking). Auto-dismiss 4s (6s if it has an action); hover/focus pauses the timer. `role="status"` (`role="alert"` for errors). Optional leading icon (`check_circle` `.ok`, `error` `.bad`) and one trailing text action.
- Mobile with no sheet open: `bottom:calc(24px + env(safe-area-inset-bottom))`.
- The full toast list is in §16.11.

### 13.2 Tooltips
`#1f1f1f` at 90% opacity (`rgba(31,31,31,.9)`), white 12/16 500, padding 4px 8px, radius 4px, max-width 240px, z `--z-tooltip`, 8px from the anchor (below by default; above if no room). Show after 500ms hover or immediately on keyboard focus; hide on leave/blur/Esc. Every icon-only button has one (text = its `aria-label`). Touch devices: no tooltips (long-press does nothing special).

### 13.3 Skeletons
```css
.sk{background:var(--cs-surface-2);border-radius:6px;position:relative;overflow:hidden}
.sk::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent);transform:translateX(-100%);animation:sk 1.2s linear infinite}
@keyframes sk{to{transform:translateX(100%)}}
```
`aria-busy="true"` on the container; skeletons are `aria-hidden`. Reduced motion: no shimmer, static `--cs-surface-2`.

| Where | Skeleton |
|---|---|
| Place panel (launched) | Hero 240px block (radius 0) → title bar 60%×22px → ticker line 80%×20px → meta bar 50%×14px → 5 action circles 40px with 32×10px label bars → fees card block 100%×112px radius 16 → coin block: 40%×28px price bar + 100%×84px chart block |
| Place panel (launchable) | `.lhero` renders immediately (static); header bars as above; Google block skeleton (§9.4) |
| Google element | §9.4 |
| Search suggestions | 2 rows: 28px circle + 55% bar (14px) |
| Feed / leaderboards | 6 rows: 40px circle + bars 60%×14px and 35%×12px + right bar 48×14px |
| "This area" card | Header bars only (row replaced by a 100%×16px bar) for at most 600ms; after that, render the real state |
| Share card preview | 472×265.5 block radius 12 |

### 13.4 Empty states
Layout for panel empties: centred column, padding `48px 32px`; 96px circle (`--cs-green-tint`, 2.5px dashed `--cs-green`) with a 40px green icon; title 16/22 600 (margin-top 16); body 14/20 text-2 (max-width 280px, margin-top 4); optional buttons (margin-top 16, gap 8).

| Where | Icon | Title | Body | Buttons |
|---|---|---|---|---|
| Live (no events) | `bolt` | `Quiet right now` | `Launches, trades and claims show up here live.` | — |
| Live filter with no matches | `bolt` | `Nothing here yet` | `No recent <launches/trades/claims>.` | `Show all` |
| Top shops · This area | `leaderboard` | `No coins in this area` | `Zoom out or move the map, or launch the first one here.` | `Show everywhere` |
| Launched (none) | `rocket_launch` | `No launches yet` | `Be the first — tap any shop on the map.` | — |
| My coins (disconnected) | `account_balance_wallet` | `Connect a wallet to see your coins` | `Your holdings, coins you launched and shops you own show up here.` | `Connect wallet` |
| My coins (connected, none) | `account_balance_wallet` | `No coins yet` | `Buy a shop's coin or launch one.` | `Find a shop` · `Launch a coin` |
| Recent trades (none) | — (inline text) | — | `No trades yet. Be the first to buy.` | — |
| Search (no results) | `search_off` (row) | `No shops match "<q>"` | `Paste a Google Maps link instead` | — |
| Map: no coins in view | ("This area" card state, §6.5) | | | |

### 13.5 Error states

| Failure | Treatment |
|---|---|
| Google Maps JS fails to load / no key / `?map=demo` | Switch to the MapLibre + OpenFreeMap fallback (BRIEF). Show a chip next to the DEMO chip (mobile: under it): amber container, `info` icon, `Basic map` + tooltip `Google Maps is unavailable. Showing OpenStreetMap; launching is paused.` Fallback map: demo coin pins work; OSM POIs open the OSM info block; Launch disabled (§9.4) |
| Map tiles fail mid-session | Leave Google's own error UI; our chrome stays usable |
| `gmp-place-details` error | §9.4 |
| Places autocomplete error | Search row `wifi_off` `Search is unavailable right now` (Coins section still searches our data) |
| `/api/resolve` failure (paste-a-link) | Link row error state (§6.2) / hero inline error (§11) |
| Offline (`navigator.onLine === false`) | Toast `You're offline. Prices will update when you're back.` (`wifi_off`); live dots turn grey; Buy/Sell/Launch/Claim primary buttons disabled with tooltip `You're offline` |
| Wallet extension error | Inline row error in the wallet modal (§12.4) |
| Geolocation denied / unavailable / timeout | Toast `Location is off. Search for a shop instead.` / `Couldn't find your location.` |
| Simulator/feed stalled > 30s | Live indicator text `reconnecting…`, dot `--cs-text-3`; no toast |
| Unknown route / bad deep link (`/c/<id>` not found, invalid `/p/<id>`) | Map loads normally + toast `That coin or place wasn't found.` |

## 14. Motion

Tokens: `--cs-ease` `cubic-bezier(.2,0,0,1)` (standard), `--cs-ease-decel` `cubic-bezier(0,0,0,1)` (enter), `--cs-ease-accel` `cubic-bezier(.3,0,1,1)` (exit); durations `--cs-dur-1` 100ms, `--cs-dur-2` 200ms, `--cs-dur-3` 300ms, `--cs-dur-4` 450ms. Only `transform`, `opacity`, `background-color`, `box-shadow` and the sheet's `height` are animated.

| Interaction | Animation | Duration / easing |
|---|---|---|
| Hover fills, chip on/off, rail indicator, `.act` shadow | `background`, `box-shadow` | 200ms `--cs-ease` |
| Press | Press overlay in | 100ms `--cs-ease` |
| Pin hover/focus | `.mk` `scale(1.12)` | 200ms `--cs-ease` |
| Pin select | Balloon from `translateY(-8px)`, opacity 0 → 1; label fades | 300ms `--cs-ease-decel` |
| New-launch pin "pop" | `scale(0)` → `1.12` (300ms decel) → `1` (150ms ease) | 450ms total |
| Buy/sell flash | `@keyframes flash` ring 1 → 2.3, opacity 1 → 0; tag fades out at the end | 1.4s `--cs-ease-decel` × 2 cycles |
| Live dots (`.live-dot`, `.area-live i`) | `@keyframes ping` scale .6 → 2.2, opacity .9 → 0 | 1.6s `--cs-ease-decel` infinite |
| New feed row | `@keyframes rowin` background `--cs-green-tint` → transparent | 600ms `--cs-ease-decel` |
| Price/number tick | Background `--cs-up-bg`/`--cs-down-bg` → transparent behind the number | 600ms `--cs-ease-decel` |
| Desktop panel open | `.panel-card` opacity 0 → 1 and `translateX(-12px)` → 0; map resize 320ms later | 300ms `--cs-ease-decel` |
| Desktop panel close / collapse | Opacity → 0, `translateX(-12px)` | 200ms `--cs-ease-accel` |
| Mobile sheet open | `--sheet-h` 0 → `52dvh` | 450ms `--cs-ease-decel` |
| Mobile sheet snap | `height` transition (the mock's) | 450ms `--cs-ease` |
| Mobile sheet close | Height → 0 | 300ms `--cs-ease-accel` |
| Tabs indicator | `translateX` + `width` to the new tab | 200ms `--cs-ease` |
| Search dropdown | None (instant, like Maps) | — |
| Dialog open (desktop) | Scrim opacity 0 → 1 (200ms); dialog opacity 0 → 1 + `scale(.96)` → 1 | 300ms `--cs-ease-decel` |
| Dialog close (desktop) | Opacity → 0 + `scale(.98)`; scrim fades | 200ms `--cs-ease-accel` |
| Dialog open/close (mobile sheet) | `translateY(100%)` ↔ 0 | 450ms decel in / 300ms accel out |
| Modal step change | Old content opacity → 0 (100ms), new content opacity 0 → 1 + `translateX(8px)` → 0 (200ms) | `--cs-ease` |
| Launch success | Two green rings around the coin, scale 1 → 1.8, opacity .6 → 0, staggered 150ms, once | 900ms `--cs-ease-decel` |
| Wrong code | `.code6` shake: translateX 0, −6, 6, −4, 4, 0 | 300ms `--cs-ease` |
| Toast in / out | `translateY(8px)` + opacity in; opacity out | 200ms decel / 150ms accel |
| Hero dismiss | Desktop: opacity → 0 + `translateY(-8px)`; mobile: slides down | 200ms / 300ms `--cs-ease-accel` |
| Map fly-to (from lists, search, deep links) | `map.panTo()` + `setZoom(16)` when the target is within ~1 viewport; otherwise `setCenter()` then `setZoom()` (no long pans) | Google's own easing |
| Spinners (`progress_activity`) | `rotate(360deg)` | 1s linear infinite |
| Skeleton shimmer | §13.3 | 1.2s linear infinite |

**`prefers-reduced-motion: reduce`** — keep the mock's global kill switch **and** the behavioural rules below:
```css
@media (prefers-reduced-motion:reduce){ *,*::before,*::after{animation:none !important;transition:none !important} }
```
- Pins never flash: the tag `+1.2 SOL` shows statically for 3s, then disappears.
- Live dots are static (no ping). Skeletons are static. Spinners are replaced by the static text `Working…` next to a static `progress_activity` icon.
- Map camera uses `setCenter`/`setZoom` only (never `panTo`).
- Sheets, dialogs and panels appear and disappear instantly; the sheet still snaps to the same heights.

## 15. Accessibility

Target: WCAG 2.2 AA.

**Touch targets.** On mobile (<768) every interactive control has a hit area of **at least 44×44px**. Where the mock's visual is smaller, keep the visual and extend the hit area with this utility (it must not change layout):
```css
.hit{position:relative}
.hit::after{content:"";position:absolute;left:50%;top:50%;width:max(100%,44px);height:max(100%,44px);transform:translate(-50%,-50%)}
```

| Control (mock size) | Mobile fix |
|---|---|
| `.chip` 32h, `.m-demo` 28h | `.hit` |
| `.ph-x` buttons 40, `.pills .btn` 40h, search `.sbtn.launch` 40, `.wallet-mini` 36 | `.hit` |
| `.seg button` 28h | `height:36px` on mobile + `.hit` |
| `.quick button` 32h | `height:44px` on mobile |
| Sheet `.handle` 22h | Hit area 44px tall (`::after` from `top:0`), and the header is also a drag zone |
| Pins (30px marker) | A transparent 44×44 `<button>` centred on the anchor (separate element; `.mk::before` is already the ring) |
| `.emoji-pick button` 40, colour swatches 24 | `.hit` |
| `.icon-btn` 40, `.ctl` 32 (desktop only) | Desktop minimum is 24px (WCAG 2.5.8); no change |

**Focus.** Global `:focus-visible{outline:2px solid var(--cs-focus);outline-offset:2px}` (from the mock). Additions:
- Controls floating over the map (chips, top-right, map controls, Layers, FABs, pins, "This area") add a white halo so the ring reads on any map imagery: `box-shadow:0 0 0 4px #fff` together with the outline.
- Text inputs inside `.tf`, `.field`, `.paste` and the search box hide their own outline. The container's `:focus-within` state (2px green border) is the indicator. Never remove an outline without a replacement.
- Round controls (pins, `.act .circ`, `.icon-btn`) get a round ring (`border-radius:50%` on the focused element).
- A "Skip to map" / "Skip to panel" link is the first focusable element (visually hidden until focused; when focused: white pill, `--cs-elev-2`, `top:12px; left:88px`).

**Keyboard.**
- Tab order: skip link → rail → search → chips → DEMO + wallet → "This area"/hero → panel content (tabs, actions…) → map controls → Layers → map (pins in market-cap order).
- Esc closes one layer per press: dropdown/popover → modal → drawer → mobile sheet/panel.
- Search dropdown is an ARIA combobox (`role="combobox"`, `aria-expanded`, `aria-activedescendant`; list `role="listbox"`, rows `role="option"`).
- Tabs, segmented controls (`role="radiogroup"`), the sheet handle (Enter/Space/↑/↓) and the code inputs follow the patterns in §8 and §12.

**Screen readers.**
- Landmarks: rail `<nav aria-label="Main">`, panel `<aside aria-label="Place details">` (rail panels: `aria-label="Live"` etc.), search `<form role="search">`, map container `aria-label="Map"`.
- The Live feed is not a live region (too noisy). A visually hidden `aria-live="polite"` summary announces at most once every 10s: `3 new trades`. Price ticks are never announced. Toasts use `role="status"` (errors `role="alert"`).
- Up/down is never colour-only: always `▲`/`▼`, `Bought`/`Sold`, and the pin `aria-label` says "up 12 percent". Fee dots and verified ticks are included in the pin label ("fees waiting", "owner verified").
- Coin art `alt="<coin name> coin art"`; sticker emojis are `aria-hidden` next to the ticker text; decorative illustrations (`.lhero`, share-card pattern, watermark) are `aria-hidden`.
- Form fields: the floating `.tf-l` is a real `<label>`; errors use `aria-invalid="true"` + `aria-describedby` → `.tf-help`.
- `translate="no"` on tickers, the wordmark, mint addresses and the Google credit row.

**Contrast.** Text tokens on white: `--cs-text` 16.5:1, `--cs-text-2` 6.5:1, `--cs-green` 5.3:1, `--cs-down` 5.2:1, `--cs-amber` 4.6:1, white on `--cs-green` 5.3:1. `--cs-text-3` (3.7:1) and `--cs-green-bright` (3.3:1) must never carry required information (§2.3).

**Reflow & zoom.** No horizontal page scroll at 320px CSS width. Text can zoom to 200% without loss (panels scroll; chips scroll). The map keeps `gestureHandling:'greedy'` on mobile so one finger pans.

## 16. Copy deck

**Voice.** Plain, short, friendly, sentence case (Maps style). The hero pitch is the only lowercase copy. Say "shop" in UI; "business" only in legal/affiliation lines. No exclamation marks, no "moon/ape/degen", no emoji in UI text except chips/stickers. Money waiting for owners is always "waiting for this shop" / "waiting for owners". Every simulated action says `Demo — no real transaction` (em dash). Strings in `<>` are variables.

### 16.1 Pitch (verbatim from BRIEF — do not edit)

| Key | String |
|---|---|
| hero.h1 | `your cafe. your barber. your kebab shop.` (last sentence green) |
| hero.p1 | `launch a coin for any business on earth. 100% of creator fees are held for the shop's verified owner.` (second sentence bold) |
| hero.p2 | `paste a google maps link. launch. done.` |
| hero.cta | `try now` |
| hero.input | `paste a google maps link` |
| hero.or | `or tap any shop on the map` · chips `Live coins`, `Near me` |
| hero.stats | `shops launched` · `waiting for owners` · `platform cut of fees` |
| hero.err.link | `That doesn't look like a Google Maps link.` |
| hero.err.place | `Couldn't find that place. Copy the link from Share in Google Maps.` |

### 16.2 Chrome

| Key | String |
|---|---|
| search.placeholder.desktop | `Search shops or paste a Google Maps link` |
| search.placeholder.mobile | `Search shops or paste a link` |
| search.aria | `Search shops or paste a Google Maps link` |
| search.btn.search / launch / wallet | `Search` · `Launch a coin` · `Connect wallet` |
| search.link.title / sub / cta | `Google Maps link detected` · `<host>/… · tap to open this place` · `Launch` |
| search.link.resolving / resolved | `Finding this place…` · `<place name> · <short address>` |
| search.link.launched | `View $<TICKER>` |
| search.link.err.title / sub | `Couldn't read that link` · `Try the full google.com/maps link` |
| search.h.coins / places / recent | `Coins` · `Places` · `Recent` |
| search.place.query | `<b><q></b> shops near <area> · <n> places` |
| search.place.cta | `Launch` (or `$<TICKER>`) |
| search.tip | `Paste a Google Maps link to launch any shop` |
| search.empty / sub | `No shops match "<q>"` · `Paste a Google Maps link instead` |
| search.offline | `Search is unavailable right now` |
| search.credit | `Google Maps` |
| chips | `Live coins` · `Cafés` · `Barbers` · `Kebab` · `Pizza` · `Bakeries` · `Pubs` · `Corner shops` · `Fees waiting <$1.2k>` |
| chips.more | `More filters` (aria) |
| demo.chip | `DEMO · simulated prices` (desktop) · `DEMO · simulated` (tablet/mobile) |
| demo.tooltip | `Prices and trades are simulated. No real transactions.` |
| wallet.pill | `Connect wallet` · `Connecting…` · `<7xKX…3pQa>` |
| wallet.menu | `Copy` · `My coins` · `View on Solscan` · `Disconnect` · balance `<2.41> SOL · <$361>` |
| area.title / live | `This area` · `<3> trading now` · `quiet right now` · `reconnecting…` |
| area.row | `<7> shops have coins` / `<$1.2k> waiting for owners` · `No fees waiting yet` |
| area.empty | `No coins here yet` / `Tap any shop on the map to launch one` · `Zoom in to see shops` |
| rail | `Live` · `Top shops` · `Launched` · `My coins` · `Help` · place `$<TICKER>` / `New coin` · app icon aria `CORNERSHOP home` |
| mapctl (aria) | `Near me` · `Zoom in` · `Zoom out` · `Layers` |
| layers | `Layers` · `Map type` · `Default` · `Satellite` · `On the map` · `Coins` · `Fees waiting dots` · `Live trade flashes` · `Owner-verified ticks` |
| fallback.chip | `Basic map` · tooltip `Google Maps is unavailable. Showing OpenStreetMap; launching is paused.` |
| drawer | `Live` · `Top shops` · `Launched` · `My coins` · `Help` · `About CORNERSHOP` · `Business opt-out` |
| collapse (aria) | `Collapse side panel` · `Expand side panel` |
| skip | `Skip to map` · `Skip to panel` |

### 16.3 Pins

| Key | String |
|---|---|
| pin.label | `$<TICKER>` / `▲<12>% · <$212k>` |
| pin.launchable | `Launch here` / `No coin yet` |
| pin.flash | `+<1.2> SOL` · `−<2.5> SOL` |
| pin.feedot.title | `Fees waiting` |
| pin.aria | `$<TICKER>, <coin name>, up <12> percent, market cap <$212k>[, fees waiting][, owner verified]` · launchable `Launch a coin here` |

### 16.4 Place panel — launched

| Key | String |
|---|---|
| hero.btn / credit | `Coin art` · `Uploaded by launcher` (demo: `Uploaded by launcher · Photo: Unsplash`) |
| ph.coin | `$<TICKER>` `<$0.000212>` `▲ <12.4>%` `· <$212k> mcap` |
| ph.meta | `<Kebab shop> coin` · `<1,284> holders` · `launched <3d> ago` |
| ph.owner | `Unclaimed · not affiliated with this business` · `Owner verification in progress` · `Claimed · verified owner` · `You own this shop · fees go to <7xKX…3pQa>` |
| tabs | `Overview` · `Coin` · `About` |
| actions | `Buy` · `Sell` · `Share` · `Claim` (`Owner`, `Payouts`) · `Open in Maps` |
| pills | `Buy $<TICKER>` · `Sell` · `Claim` · `Share` · `Open in Maps` |
| fees.h3 | `<b><$1,240></b> waiting for this shop` · `Fees for this shop build up here` · `Claimed by the owner` · `<b><$1,240></b> earned for your shop` |
| fees.sol | `≈ <8.27> SOL` |
| fees.p | `100% of creator fees from $<TICKER> are held for the owner. We take nothing.` · `An owner is verifying right now.` · `<b><$3,410></b> paid to the shop so far · ≈ <22.73> SOL` · `Paid to <7xKX…3pQa> · first payout after the 72-hour hold` |
| fees.cta | `I own this business` · `Learn more` · `Verification in progress` · `Payout settings` |
| feemini | `<$1,240>` `≈ <8.27> SOL` · `waiting for this shop` · `I own this business` · `Claimed` |
| coin.sub | `▲ <12.4>% past 24h` / `past hour` / `past 7 days` / `all time` |
| coin.range | `1H` · `24H` · `7D` · `All` |
| coin.stats | `Market cap` · `Volume 24h` · `Holders` · `Fees earned` |
| chartcard.k | `$<TICKER> · 24h` |
| sec.place | `About this place` |
| trades | `Recent trades` · `Bought` · `Sold` · `Show more` · `No trades yet. Be the first to buy.` |
| holders | `Top holders` · `<4.2>% of supply` |
| ca.row | `<BkT7…pump>` / `$<TICKER> mint · Solana · pump.fun` · aria `Copy mint address` |
| links | `View on Solscan` · `Chart on DexScreener` · `Trade on pump.fun` |
| about.coin | `About this coin` · `Launched by <7xKX…3pQa>` · `Launched <4 Oct 2026>` · `Category <Kebab shop>` · `Launchpad: pump.fun` |
| about.fees | `Fees & owner` · `100% of creator fees go to this shop's vault` · `Owners verify by a phone call to the number on the Google listing` |
| foot | `Coins are launched by anyone. The business has not endorsed this coin.` · `Report` · `Business opt-out` |
| back chip | `Live` · `Top shops` · `Launched` · `My coins` |

### 16.5 Place panel — launchable

| Key | String |
|---|---|
| lhero.cap | `No coin yet` |
| ph.title | `Be the first to launch this shop` |
| ph.meta | `One official coin per place` · `first launch wins` |
| ph.line | `100% of creator fees are held for the owner` |
| actions | `Launch` · `Watch` (`Watching`) · `Share` · `Claim` · `Open in Maps` |
| pills | `Launch a coin` · `Watch` · `Claim` · `Share` · `Open in Maps` |
| steps | `Launch` / `~20 seconds` · `People trade` / `fees build up` · `Owner claims` / `phone check` |
| tab.coin.tooltip | `No coin yet` |
| foot | `Coins on CORNERSHOP are launched by the public and are not affiliated with the business.` · `Business opt-out` |
| fallback.launch.tooltip | `Launching needs Google Maps. Try again later.` |
| gmp.err | `Couldn't load details for this place` · `Your coin info above still works.` · `Try again` · `Open in Google Maps` |

### 16.6 Buy / sell box
`Buy` · `Sell` · placeholder `0.0` / `0` · unit `SOL` / `$<TICKER>` · quick `0.1 SOL` `0.5 SOL` `1 SOL` / `25%` `50%` `100%` · `You receive` `≈ <2.36M> $<TICKER>` / `≈ <0.48> SOL` · `Balance <2.41> SOL` · `You hold <4.1M> $<TICKER>` · `Slippage 2%` · buttons `Buy $<TICKER>` `Sell $<TICKER>` `Connect wallet to buy` `Connect wallet to sell` `Enter an amount` `Not enough SOL` `Not enough $<TICKER>` `Buying…` `Selling…` · `Demo — no real transaction`.

### 16.7 Rail panels
`Live` · `simulated · updating` · `All` `Trades` `Launches` `Claims` · `bought` · `sold` · `launched · first launch wins` · `claimed fees` · `New` · `<12s> ago` · `See all top shops` · `<12> new events · Show` · `Top shops` · `Market cap` · `Fees earned` · `Everywhere` · `This area` · `<Kebab shop> · <$1,240> fees` · `<Kebab shop> · <$212k> mcap` · `Launched` · `Newest first` · `<Bakery> · launched by <7xKX…3pQa>` / `by you` · `My coins` · `Your shops` · `available` · `Holding` · `Launched by you` · `mcap` · `Payout settings`.

### 16.8 Launch modal

| Key | String |
|---|---|
| stepper | `Details` · `Sign in` · `Review` · `Launch` |
| details.h2 / sub | `Launch a coin for <place name>` (fallback `Launch a coin for this shop`) · `One official coin per place — first launch wins. You can't change the name or ticker later.` |
| details.art | `Coin art` · `or pick a sticker` · `Colour` |
| details.fields | `Coin name` · `Ticker` · `Category` (+ options `Café` `Barber shop` `Kebab shop` `Pizza` `Bakery` `Pub` `Corner shop` `Restaurant` `Other`) |
| details.box | `100% of creator fees → held for this shop` / `Unclaimed · not affiliated with this business. The owner claims by phone verification.` |
| details.buy | `First buy (optional)` · `None` `0.1 SOL` `0.5` `1` |
| details.err | `Give your coin a name` · `Ticker must be 2–8 letters or numbers` · `$<TICKER> is already used by another shop. You can still use it.` · `Use a PNG, JPG, WebP or GIF under 2 MB.` |
| buttons | `Cancel` · `Continue` · `Back` · `Launch $<TICKER>` · `Back to review` · `Try again` |
| signin.h2 / sub | `Sign in to launch` · `You'll be listed as the launcher. In the demo nothing is signed or sent.` |
| review.h2 / sub | `Review your coin` · `The name and ticker are permanent.` |
| review.place | `Place` |
| review.launchpad | `Launchpad: pump.fun · Creator fees → this shop's vault (100%)` |
| review.rows | `Network` `Solana` · `First buy` `<0.1 SOL>` / `None` · `Platform cut` `0%` · `Network fee` `~0.02 SOL (simulated)` |
| review.check | `I understand this coin isn't affiliated with the business and anyone can trade it.` |
| launching | `Launching $<TICKER>…` · `Creating the coin on pump.fun` · `Pointing creator fees to the shop's vault` · `Putting it on the map` |
| success | `$<TICKER> is live` · `You launched the first coin for this shop. Every trade now builds fees for the owner.` · `First buy: <0.1> SOL → <2.36M> $<TICKER>` · `Share on X` · `View coin` · `Know the owner? Send them this page so they can claim the fees.` · `Copy link` |
| err.taken | `Someone launched this shop first` · `This place now has $<TICKER>. One official coin per place.` · `View $<TICKER>` · `Close` |
| err.failed | `Launch failed` · `Nothing was sent. You can try again.` |
| err.wallet | `Your wallet disconnected. Sign in again to continue.` |
| note | `Demo — no real transaction` |

### 16.9 Share

| Key | String |
|---|---|
| title | `Share $<TICKER>` · `Share this shop` |
| buttons | `Post on X` · `Copy link` · `Download image` · `More` |
| post.coin | `$<TICKER> is the coin for <coin name> on CORNERSHOP. 100% of creator fees are held for the shop's verified owner. <sticker emoji>` |
| post.launched | `I just launched $<TICKER> on CORNERSHOP — the coin for <coin name>. 100% of creator fees are held for the shop's verified owner.` |
| post.place | `This shop has no coin yet. First launch wins.` |
| post.owner | `We're the verified owner of $<TICKER> on CORNERSHOP. 100% of creator fees from every trade are held for our shop.` |
| card | `<$TICKER>` · `<coin name>` · `▲ <12.4>% · <$212k> mcap` · `<$1,240> waiting for this shop` · `Claimed by the owner` · `Just launched` · `No coin yet` · `First launch wins.` · `100% of creator fees held for the shop` · `cornershop.tiejiucai.workers.dev` · `DEMO · simulated prices` |

### 16.10 Claim modal

| Key | String |
|---|---|
| stepper | `Verify` · `Code` · `Payout` · `Done` |
| verify | `Claim fees for this shop` · `We'll call the phone number on this shop's Google listing and read out a 6-digit code.` · `Listed number` · `We look this number up on Google ourselves. It can't be changed here.` · `<$1,240> waiting for this shop` / `≈ <8.27> SOL · paid to the wallet you choose next` · `Can't answer this number?` · `Call me with a code` · `See other ways` |
| verify.blocked | `This listing has no phone number. Choose another way to verify.` · `We can't call this number. Choose another way to verify.` · `Someone is verifying this shop right now. Try again in 10 minutes.` · `Too many attempts. Try again in 1 hour.` · `This shop is already claimed` / `If that's wrong, tell us and we'll review it.` / `Report a problem` |
| code | `Enter the code` · `We're calling <+44 20 •••• ••23> now. Answer and listen for 6 digits.` · `Calling…` · `Call placed · code expires in 10 minutes` · `Demo code: 482 913` / `No call is made in the demo.` · `That code didn't match. <2> tries left.` · `Too many wrong codes. Request a new call.` · `Call me again` · `Call again in <45 s>` · `Use another way` · `Verify` · `Checking…` · aria `Digit <n> of 6` |
| payout | `Sign in to get paid` · `Where should the fees go?` · `Fees for $<TICKER> are paid to this Solana wallet.` · `Connected wallet` · `Another address` · `Solana address` · `That isn't a valid Solana address` · `72-hour hold on the first payout` / `So a hijacked listing can be disputed before any money moves.` · `I'm the owner of this business, or authorised by the owner.` · `Claim <$1,240>` · `Claim this shop` |
| done | `You've claimed this shop` · `<$1,240> (≈ <8.27> SOL) will be paid to <7xKX…3pQa> after the 72-hour hold. New fees follow automatically.` · `Share that you're verified` · `Done` |
| other | `Other ways to verify` · `These take longer than a call.` · `Back to phone call` · `Code on your website` / `Add a short code to a page on <host>. We check it automatically.` / `This listing has no website` · `Email at your website's domain` / `We'll send a link to an address @<domain>.` · `Manual review` / `Post a code on the shop's socials, or send a photo of it in the shop. Takes 1–3 days.` |
| other.website | `Add this text anywhere on <host>, then press Check.` · `Check my website` · `We couldn't find the code yet. It can take a few minutes after you publish.` |
| other.email | `Email` · `Send link` · `Check your inbox` · `Resend in <45 s>` · `Demo: open the link` |
| other.manual | `Post this code on the shop's Instagram, Facebook or X, or take a photo of it on paper inside the shop.` · `Link to the post` · `Add a photo` · `Submit for review` · `We'll review your claim` / `Usually within 3 days. We'll show "Owner verification in progress" on the shop until then.` |
| note | `Demo — no real call is made` |

### 16.11 Toasts

| Trigger | String |
|---|---|
| Copy mint / link / address | `Mint address copied` · `Link copied` · `Address copied` |
| Wallet | `Connected · <7xKX…3pQa>` · `Disconnected` |
| Buy / sell (demo) | `Bought <2.36M> $<TICKER> for <0.5> SOL · Demo` · `Sold <4.1M> $<TICKER> for <0.48> SOL · Demo` (action `View`) |
| Launch | `$<TICKER> launched · Demo` (action `Share`) |
| Watch | `We'll let you know when someone launches this shop.` · `Stopped watching this shop.` |
| Simulated link rows | `Simulated coin — it isn't on <Solscan/DexScreener/pump.fun>. Real coins open there.` |
| Race | `This shop already has a coin — $<TICKER>` |
| Location | `Location is off. Search for a shop instead.` · `Couldn't find your location.` |
| Offline | `You're offline. Prices will update when you're back.` |
| Deep link | `That coin or place wasn't found.` |
| Report / opt-out | `Thanks — we'll review it.` · `Request sent. We'll reply within 3 days.` |
| Image saved | `Image saved` |

### 16.12 Wallet modal
`Connect` · `Sign in to launch, trade and claim.` · `Phantom` · `Solflare` · `Backpack` · `Detected` · `Install` · `Open in app` · `Approve in <Phantom>…` · `Request cancelled in <Phantom>` · `<Phantom> isn't responding. Try again.` · `or` · `Continue with email` · `Email` · `Send code` · `We sent a 6-digit code to <s…@…com>` · `Demo code: 271 604` · `Resend in <45 s>` · `Verify` · `By continuing you agree to the Terms and Privacy Policy. We never ask you to sign anything in the demo.`

### 16.13 Explainers

| Key | String |
|---|---|
| demo.h2 / body | `This is a demo` · `Prices, trades, launches and claims are simulated. No real transaction is ever sent and you're never asked to sign anything. Real shops on the map are real Google places; the seeded coins are fictional.` · `Got it` |
| unclaimed.popover | `Anyone can launch a coin for any shop. Until the owner verifies, the coin isn't affiliated with the business and all creator fees are held for them.` · `How claiming works` |
| owner.popover | `Claimed by the owner on <2 Oct 2026>. Fees go to the shop's wallet.` · `View payout wallet on Solscan` |
| demo.gblock | `Demo shop · fictional business` |
| help | `How launching works` · `Where the fees go` · `Claiming your shop` · `Is this real money?` · `Terms` · `Privacy` · `Google Maps Terms` · `Google Privacy` |
| report | `Report this coin` · `Pretends to be the business` · `Offensive name or art` · `Scam or misleading` · `Something else` · `Details (optional)` · `Send report` |
| optout | `Own this business?` · `You can claim the fees, or ask us to hide coins for your business.` · `Claim the fees` · `Ask us to hide it` · `Your name` · `Email at your business domain` · `Anything we should know` · `Send request` |

## 17. Do / Don't

| Do | Don't |
|---|---|
| Use the real Google default basemap (raster, no `mapId`, `clickableIcons:true`) | Restyle the basemap heavily, hide `poi.business`, or swap the basemap for a custom style |
| Put the CORNERSHOP app icon + wordmark in the rail, favicon, hero, watermark and share card | Put the Google logo, the "Google Maps" wordmark or any Google product icon in **our** chrome (Google's own map logo and the `Google Maps` text credit are legal attribution, not chrome — keep them) |
| Use `--cs-green` as the one primary accent | Use Google blue (`#1a73e8`, `#4285f4` or similar) for anything of ours, or the Google 4-colour palette anywhere. `--cs-loc` blue is only the user-location dot |
| Show `$TICKER` and coin name exactly as the launcher typed them | Store or display Google's `displayName` as the coin's name; auto-generate tickers server-side from Google data |
| Show tickers, coin names, categories (launcher-picked) and on-chain numbers in feeds, leaderboards, pins, search "Coins" rows and the share card | Show Google names, ratings, addresses, photos or hours in feeds, leaderboards, pins or the share card |
| Render Google place content only through `gmp-place-details` / `-compact`, inside its own bordered card, with its attribution intact | Recreate Google's place content for real places, overlay or crop Google's element, hide its attribution or its "Open in Maps" button |
| Persist only place IDs (+ coordinates ≤ 30 days) | Persist Google names, phones, addresses, photos or photo URIs (in localStorage, our DB or share images) |
| Use launcher-uploaded art or a sticker for coins | Use a Google photo as coin art, hero, avatar or share-card image |
| Label every coin `Unclaimed · not affiliated with this business` until the owner verifies | Imply endorsement ("official", "verified") before a successful claim |
| Show `DEMO · simulated prices` at all times and `Demo — no real transaction` on every simulated action | Request signatures or transactions, or hide the demo chip |
| Use SOL for amounts, USD (with SOL secondary) for fees and market caps, base58 mints ending in `pump`, Solscan / DexScreener / pump.fun links | Show ETH, `0x…` addresses, chain IDs, Robinhood Chain, EIP-6963 or "switch network" anywhere |
| Use the tokens in §2; one green, one amber, up/down colours | Introduce new colours, gradients or shadows not in §2 (the SOL glyph gradient is the only exception) |
| Keep Maps-like restraint: white surfaces, round icon buttons, 12–28px radii, Roboto Flex | Add stickers, awnings, newspaper collage, neon, or anything resembling localer.fun's mint-green collage |
| Make every control do something (§18) | Ship decorative buttons, dead links or "coming soon" controls |
| Keep the mobile search, chips and FABs reachable with one thumb; ≥ 44px hit areas | Put essential controls only behind hover, or below 44px hit areas on mobile |
| Respect `prefers-reduced-motion` (§14) | Loop animations without the reduced-motion fallback |
| Keep Google's map attribution visible at every sheet height and breakpoint | Let the sheet, Layers tile, toasts or the watermark cover Google's logo or terms |

## 18. Control behaviour index (every control does something)

The user's rule: **every button must work**. This table is the contract for QA; each row needs an automated or manual test. "Requires wallet" means: if disconnected, open the wallet modal (§12.4) first and continue the action after a successful connect (cancel = no action). "New tab" = `target="_blank" rel="noopener noreferrer"`. "Simulated link" = in the prototype every coin is simulated, so these show the toast `Simulated coin — it isn't on <site>. Real coins open there.` instead of navigating; with a real mint they open the URL in a new tab.

### 18.1 Global chrome

| Control | Action | Result |
|---|---|---|
| Rail app icon / mobile search logo (desktop: link `?`) | Click | Desktop: close any panel, clear selection, reset filters, keep the map viewport. Mobile: open the navigation drawer (§6.9) |
| Rail `Live` / `Top shops` / `Launched` / `My coins` | Click | Open that rail panel (§10); clicking the active item again closes the panel |
| Rail place entry (`$TICKER` / `New coin`) | Click | Re-open the selected place's panel (expands a collapsed panel) and pan to the pin if off-screen |
| Rail `Help` | Click | Open the Help panel (§12.6) |
| Drawer items | Tap | Same as the rail items; the drawer closes. `About CORNERSHOP` opens Help at the top; `Business opt-out` opens the opt-out sheet |
| Search input | Focus / type / Enter | Opens the dropdown (§6.2). Enter = activate the highlighted row, or the first row when none is highlighted |
| Search `search` button (desktop) | Click | Same as Enter; with an empty input it focuses the input |
| Search rocket (`Launch a coin`) | Click | If a launchable place is selected → open the launch modal; if a launched place is selected → toast `This shop already has a coin — $TICKER`; else → focus search, dropdown shows the link tip |
| Mobile `.wallet-mini` | Tap | Disconnected → wallet modal; connected → account menu as a bottom sheet |
| Link row / its `Launch` | Click | Resolve via `/api/resolve` → fly to the place → open its panel; if launchable, also open the launch modal; if launched, open the coin (button reads `View $TICKER`) |
| Coin row | Click | Fly to the coin (zoom 16) + open its panel; add to Recent |
| Place row | Click | Fly to the place + open its panel (launchable or launched); row's `Launch` text also opens the launch modal |
| Category query row | Click | Turn on the matching chip and fit the map to matching coins |
| Recent row | Click | Same as a coin/place row |
| Mobile search `arrow_back` | Tap | Close the dropdown, blur, restore chips/FABs |
| Chips (category, Live coins, Fees waiting) | Click | Toggle the filter (single-select); pins and "This area" update; on again → off |
| `.chips-next` | Click | Scroll the chips row right by 240px (smooth unless reduced motion) |
| DEMO chip | Click | Open the DEMO explainer (§12.6) |
| `Connect wallet` pill | Click | Open the wallet modal |
| Connected wallet pill | Click | Toggle the account menu |
| Account menu `Copy` | Click | Copy the full address; toast `Address copied` |
| Account menu `My coins` | Click | Open the My coins panel; close the menu |
| Account menu `View on Solscan` | Click | New tab `https://solscan.io/account/<address>` (a real address even in the demo) |
| Account menu `Disconnect` | Click | `standard:disconnect`, clear `cs_wallet`, pill → disconnected, toast `Disconnected` |
| "This area" row | Click | Open Top shops with scope `This area` |
| Locate (`Near me`) / mobile locate FAB / hero `Near me` chip | Click | Request geolocation → centre at zoom 16, show the user dot (§6.6 states); errors → toast |
| Zoom in / out | Click | `map.setZoom(±1)`; disabled at limits |
| Layers tile / mobile Layers FAB | Click | Toggle the Layers popover / sheet |
| Layers `Default` / `Satellite` | Click | `map.setMapTypeId('roadmap' / 'hybrid')`; saved |
| Layers toggles | Click | Show/hide coins, fee dots, trade flashes, verified ticks; saved |
| Pin (coin) | Click / Enter | Select it (balloon), open its panel, pan per §4.5 |
| Pin (launchable balloon) | Click | Scroll the panel to the top and pulse the Launch action once (200ms scale 1.06) |
| Google POI icon on the map | Click | `event.stop()` + open its panel (§7.4) |
| Empty map | Click | Desktop: nothing (selection stays, as in Maps). Mobile: if a sheet is at Full, collapse it to Half |
| Collapse tab | Click | Collapse / expand the side panel (selection kept) |
| Toast action (`View`, `Share`) | Click | `View` → open the coin's Coin tab; `Share` → open the Share modal |
| Skip links | Enter | Move focus to the map container / panel |

### 18.2 Place panel

| Control | Action | Result |
|---|---|---|
| Hero `Coin art` / mobile `.ph-img` | Click | Coin art lightbox (§12.6) |
| Hero credit link (`Unsplash`, demo only) | Click | New tab to the photo's Unsplash page |
| Mobile `.ph-x` Share / Close | Tap | Share modal / close the sheet (deselect the pin) |
| Sheet handle | Tap / drag / keys | §8.3 |
| `.ph-unclaimed` `info` | Click | Unclaimed info popover; `How claiming works` → Help "Claiming your shop" |
| Tabs | Click | Switch tab (§8.8) |
| `Buy` (action / pill) | Click | Requires wallet → Coin tab, trade box on `Buy`, focus the amount input, scroll it into view (mobile: sheet to Full) |
| `Sell` | Click | Same with the `Sell` tab; disabled when you hold 0 |
| `Share` | Click | Share modal (coin or place variant) |
| `Claim` | Click | Claim modal at Verify. Claimed shop → `Owner` popover; you're the owner → `Payouts` opens Claim at Payout |
| `Open in Maps` | Click | New tab `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=<placeId>` (demo shops: toast `Demo shop — it isn't on Google Maps.`) |
| `Launch` / `Launch a coin` | Click | Launch modal at Details (Sign in is skipped if connected) |
| `Watch` / `Watching` | Click | Requires wallet → toggle watch + toast |
| Back chip (`Live`, `Top shops`…) | Click | Return to that rail panel at its previous scroll position |
| `I own this business` (fees card / fee mini) | Click | Claim modal at Verify |
| `Learn more` (fees card) | Click | Help panel at "Where the fees go" |
| `Payout settings` | Click | Claim modal at Payout (owner only) |
| Mobile `.chart-card` | Tap | Coin tab |
| Timeframe `1H`/`24H`/`7D`/`All` | Click | Redraw the sparkline + sub label |
| Sparkline | Drag / arrows | Scrub (§8.10) |
| Trade `Buy` / `Sell` tabs | Click | Switch mode, keep the input if valid |
| Quick amounts | Click | Fill the input (`0.1`/`0.5`/`1` SOL or 25/50/100% of holdings) |
| Trade primary button | Click | Simulated trade (1.2s) → toast, new trade row, pin flash, balances update; disabled states §8.11 |
| Unit pill | — | Not interactive (label only; no cursor/hover) |
| `Show more` (trades) | Click | Load 20 more rows |
| Trade row (real coins only) | Click | New tab `https://solscan.io/tx/<signature>`; simulated rows are not interactive |
| CA copy row | Click | Copy the full mint; icon → `check` 1.5s; toast `Mint address copied` |
| `View on Solscan` / `Chart on DexScreener` / `Trade on pump.fun` | Click | Simulated link → `https://solscan.io/token/<mint>` / `https://dexscreener.com/solana/<mint>` / `https://pump.fun/coin/<mint>` |
| Google element's own controls (photos, hours, website, phone, "Open in Maps", disclosures) | — | Google-owned behaviour; do not intercept |
| `.gb-btn` `Open in Maps` and `.gb-rows` (demo lookalike) | Click | Toast `Demo shop — it isn't on Google Maps.`; hours row toggles a fictional hours list |
| Google block error `Try again` / `Open in Google Maps` | Click | Re-mount the element / new tab to the place on Google Maps |
| Footer `Report` / `Business opt-out` | Click | Report sheet / Opt-out sheet (§12.6) |

### 18.3 Rail panels, hero, modals

| Control | Action | Result |
|---|---|---|
| Live filter tabs | Click | Filter the feed |
| Feed / leaderboard / Launched / My coins row | Click | Fly to the coin (zoom 16) + open its panel with a back chip |
| `.seg` Market cap / Fees earned | Click | Re-sort + swap the row metrics (§10.3) |
| Scope chips `Everywhere` / `This area` | Click | Rescope the leaderboard |
| `See all top shops` | Click | Open the Top shops panel |
| `<n> new events · Show` | Click | Insert the buffered events |
| Empty-state buttons | Click | As written in §13.4 (`Show all` clears the filter; `Show everywhere` switches scope; `Find a shop` closes the panel and focuses the map; `Launch a coin` focuses search with the link tip) |
| Hero `close` | Click | Dismiss the hero, set `cs_hero_seen` |
| Hero `try now` | Submit | Empty input → dismiss the hero and focus search with the link tip. Link → resolve (spinner) → dismiss → open the place (launchable: also open the launch modal). Error → inline message (§11) |
| Hero `Live coins` chip | Click | Dismiss the hero + turn on the `Live coins` filter |
| Hero `Near me` chip | Click | Dismiss the hero + Near me |
| Dialog `close` / scrim / Esc | Click / key | Close (ignored during busy steps) |
| Launch: art button, stickers, swatches, fields, category, first-buy seg | Click / type | §12.2 |
| Launch: art remove badge | Click | Remove the uploaded art; reselect the first sticker |
| Launch: `Cancel` / `Continue` / `Back` / `Launch $TICKER` | Click | Close / validate + next / previous / run Launching |
| Launch success: `Share on X` | Click | New tab X intent with the "launched" post text + coin URL |
| Launch success: `View coin` / `Copy link` | Click | Close and show the coin / copy the coin URL + toast `Link copied` |
| Launch errors: `View $BREAD` / `Try again` / `Back to review` / `Close` | Click | Open the other coin / re-run / Review / close |
| Claim: `Call me with a code` | Click | Simulated call (Code step) |
| Claim: `Can't answer this number?` / `Use another way` / `See other ways` | Click | Other ways sub-screen |
| Claim: code inputs / `Verify` | Type / click | Check the code (demo accepts `482913`; any other code counts as wrong) |
| Claim: `Call me again` | Click | Restart the call; 45s cooldown |
| Claim: payout `.opt` cards, address field, checkbox, `Claim $1,240` | Click | §12.3; submitting → Done |
| Claim: `Share that you're verified` / `Done` | Click | Share modal (owner variant) / close |
| Claim: `Report a problem` | Click | Report sheet with `Something else` preselected |
| Claim other ways: option cards | Click | Open the sub-screen (disabled cards do nothing and show their reason) |
| Website `content_copy` / `Check my website` | Click | Copy the code + toast / simulated check (demo: success after 1.5s) |
| Email `Send link` / `Resend` / `Demo: open the link` | Click | Simulated send / resend after cooldown / advance to Payout |
| Manual `Add a photo` / `Submit for review` | Click | Image picker / pending state + Done variant |
| Wallet rows | Click | `standard:connect` on that wallet (§12.4) |
| Wallet `Install` / `Open in app` | Click | New tab to the download page / deep link into the wallet's browser |
| `Continue with email` / `Send code` / `Verify` / `Back` | Click | §12.4 flow |
| Wallet footer `Terms` / `Privacy Policy` | Click | New tab `/terms` / `/privacy` (our pages; they reference Google's terms and privacy as BRIEF requires) |
| Share `Post on X` | Click | New tab X intent with the textarea text + share URL |
| Share `Copy link` / `Download image` / `More` | Click | Copy the URL + toast / save the PNG + toast `Image saved` / `navigator.share({title,text,url})` |
| DEMO explainer `Got it` | Click | Close |
| Report `Send report` / Opt-out `Claim the fees` / `Ask us to hide it` / `Send request` | Click | Toast / Claim modal / show the form / toast (prototype stores nothing) |
| Help rows | Click | Expand/collapse (`aria-expanded`); footer links open in a new tab |
| Popover links (`How claiming works`, `View payout wallet on Solscan`) | Click | Help at Claiming / new tab `https://solscan.io/account/<payout>` |

### 18.4 Deep links & persistence

| URL / key | Behaviour |
|---|---|
| `/` | Map; hero if first visit |
| `/c/<coinId>` | Open that coin (fly + panel). Not found → toast |
| `/p/<placeId>` | Open that place (launched or launchable). Invalid → toast |
| `?state=hero` / `unlaunched` / `launch` / `live`, `?search=1` | Mock QA states. Keep them in the app behind `import.meta.env.DEV` |
| `?map=demo` | Force the MapLibre fallback |
| localStorage (all try/catch) | `cs_hero_seen`, `cs_recent` (coin IDs/place IDs only), `cs_layers`, `cs_wallet`, `cs_launched_seen_at`. Nothing from Google except place IDs |
| sessionStorage | `cs_viewport` (centre/zoom; cleared on tab close) |
| Browser back | Panel open → back closes it (push a history entry on open: `/c/…` or `/p/…`); modal open → back closes the modal |

## 19. Appendix: mock states, deviations, open questions

### 19.1 Mock QA states (https://cornershop-mock.tiejiucai.workers.dev)

| URL | Shows | App equivalent |
|---|---|---|
| `/` | Desktop: `$KEBAB` selected, launched panel; mobile: sheet at Half (the two screenshots) | `/c/kebab` |
| `?state=hero` | First-visit hero over the live map, no selection | First visit to `/` |
| `?state=unlaunched` | Launchable demo place (Crumb & Co. Bakery) with `.lhero`, steps, demo `.gblock` | `/p/<placeId>` for an unlaunched place |
| `?state=launch` | Launch modal, Details step | Launch from a launchable place |
| `?state=live` | Live feed + Top shops preview in the panel | Rail `Live` |
| `?search=1` | Search dropdown open with the link row | Focus search, paste a Maps link |
| `?place=ChIJ…&lat=…&lng=…` | Real Google place via `gmp-place-details` | `/p/<placeId>` |

### 19.2 Seeded demo coins (FICTIONAL — never real businesses)
Values from the mock, converted to SOL. Mints are fake base58 strings ending in `pump`, generated deterministically from the id (e.g. `kebab` → `BkT7yM3cQ9xX1rLqTzF4nH8pVwJdUe2sGa5KcR6tpump`).

| id | Ticker | Coin name | Category | Sticker / `--bg` | lat, lng | 24h | Mcap | Fees | Notes |
|---|---|---|---|---|---|---|---|---|---|
| kebab | KEBAB | Bosphorus Grill | Kebab shop | 🥙 `#ffe4cc` | 51.54905, −0.07535 | +12.4% | $212k | $1,240 | price $0.000212, 1,284 holders, vol $48.1k |
| bean | BEAN | Beanstalk Coffee Co. | Café | ☕ `#efe3d6` | 51.55185, −0.06905 | +4.1% | $86k | $420 | |
| fade | FADE | Fadeaway Barbers | Barber shop | 💈 `#e3e8ff` | 51.54445, −0.08055 | −3.2% | $41k | $180 | label left |
| pepi | PEPI | Nonna Pepi's Pizza | Pizza | 🍕 `#ffe0db` | 51.54525, −0.06565 | +27.9% | $154k | $960 | buy flash `+1.2 SOL` |
| crow | CROW | Kettle & Crow | Pub | 🍺 `#fff1c7` | 51.55275, −0.07905 | +1.8% | $63k | $0 | owner-verified, label left |
| late | LATE | Ridley Late Shop | Corner shop | 🏪 `#dff3e6` | 51.54215, −0.07215 | −8.6% | $19k | $75 | sell flash `−2.5 SOL` |
| noodl | NOODL | Lucky Noodle Bar | Noodle bar (`Restaurant`) | 🍜 `#fde2c4` | 51.54925, −0.06235 | +6.3% | $37k | $140 | |
| simit | SIMIT | Simit House | Bakery | 🥯 `#e2f0ff` | 51.54095, −0.07905 | +15.2% | $92k | $610 | label left |
| crumb (unlaunched demo place) | — (`CRUMB` prefill) | Crumb & Co. Bakery | Bakery | 🥐 `#f6e7d2` | 51.54655, −0.06985 | — | — | — | launchable demo |

Fee dots show for kebab, pepi and simit (≥ $500). User-location demo point: 51.5433, −0.0688. Demo phone numbers use the Ofcom drama range `020 7946 0xxx`; demo websites use `.example`.

### 19.3 Deviations from the mock (intentional — this file wins)
1. **Chain**: Solana + pump.fun replaces Robinhood Chain/ETH everywhere: `.eth` glyph → `.sol` glyph; ETH amounts → SOL (`+0.12 ETH` → `+1.2 SOL`, `−0.3 ETH` → `−2.5 SOL`, first buy `0.01/0.05/0.1 ETH` → `0.1/0.5/1 SOL`); `0x…` addresses → base58; contract row → mint row (`$KEBAB mint · Solana · pump.fun`); EIP-6963 → Wallet Standard (Phantom, Solflare, Backpack); no chain switching. Fees show USD primary with `≈ x SOL` secondary.
2. Material Symbols URL: weight axis `400..700` (the mock loaded only 400, so its `'wght' 500/700` icon settings didn't render) plus 22 new icons.
3. DEMO chip is a `<button>` (opens the explainer) instead of a `<div>`.
4. Launched footer reads `The business has not endorsed this coin.` (the mock interpolated the coin name).
5. Down-trending sparklines are red (the mock drew every sparkline green).
6. Buy/sell flash runs 2 cycles and stops (the mock looped forever).
7. Tablet (768–1023) overrides (§4.3); the mock only had the 767px breakpoint, and its desktop layout overflows at tablet widths.
8. Mobile navigation drawer (§6.9); the mock had no way to reach Live/Top shops/Launched/My coins on mobile.
9. The collapse tab collapses the panel and keeps the selection (the mock closed the place).
10. Mobile dialogs are bottom sheets (the mock centred them at every width).
11. ≥ 44px mobile hit areas via `.hit` (§15); the mock had 28–40px targets.
12. Selected pin rendered in `floatPane` with `preventMapHitsAndGesturesFrom` (research/google.md).
13. Sheet drag + fling gestures (the mock only cycled snaps on tap).
14. The `.trade` box (CSS-only in the mock) is rendered in the Coin tab; the `About` tab has defined content.
15. Fees card gains the `.sol` secondary line; fee mini gains `≈ x SOL`.
16. Live panel's Top shops preview gets `See all top shops`; Top shops is also its own rail panel with scope chips.
17. Extra `--gmp-*` properties on `.gmp` (§9.3) and a `.gmp-compact` style for modals.
18. The user-location halo scales with accuracy.
19. The mock hard-codes the Maps browser key in HTML. The app reads `import.meta.env.VITE_GOOGLE_MAPS_KEY` (BRIEF) and never ships the server key.
20. Mock-only test hooks (`window.__map`, `window.__real`, `document.body.dataset.tiles/gmp`) are not part of the app. Use `data-testid` instead.

### 19.4 Open questions for product / legal
1. **Per-shop vault on Solana**: pump.fun creator fees go to the creator address. The "shop's vault (100%)" needs a per-place PDA/escrow program as the creator. Engineering to confirm before the copy is used with real money.
2. **Ticker collisions**: this spec warns but doesn't block duplicate tickers across shops. Product to confirm.
3. **Displaying `displayName`** in the launch modal title and prefill costs one Places Pro call per launch attempt. It is allowed (display + prefill), but confirm the budget.
4. **Google's duplicate "Open in Maps"** (ours + the UI Kit's): accepted for now. Revisit if users find it confusing; never hide Google's.
