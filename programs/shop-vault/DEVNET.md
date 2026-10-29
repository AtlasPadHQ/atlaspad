# shop-vault on devnet

**Status (2026-10-08 20:2x UTC): DEPLOYED on devnet and the full live e2e PASSED (44/44 checks)** — report `scripts/out/devnet-e2e-20261008T202110.json`. Deployed with RPC_URL = the user's Alchemy devnet endpoint (server-only key); ALT `AcC53qbWCpZUsSXjaN36h35KyqQQH37oreFnrbZBtB6G`; program rent locked 0.18422620 SOL. e2e fixes: waitTx now polls getSignatureStatuses over HTTP (Alchemy has no signatureSubscribe), error objects are printed. (Older note below kept for history.)

~~Status (2026-10-08 13:46 UTC): NOT DEPLOYED YET.~~
The public faucet (`requestAirdrop` on `https://api.devnet.solana.com`, through `solana airdrop` and direct RPC calls)
refused all 60 requests made between 13:21 and 13:46 UTC. They asked for 2, 1, 0.5, 0.2 and 0.1 SOL for the deployer,
buyer and launcher, with exponential backoff between six rounds. Every one returned HTTP 429: *"You've either reached your airdrop limit today or the airdrop faucet has run dry"*.
No transaction has been sent to devnet.

Everything else is ready. The deploy script, the e2e script and the keys exist. The full e2e passed end to end against a
local validator that cloned the live **devnet** pump.fun programs and accounts (see [Rehearsal](#rehearsal-localnet-with-devnets-pump-programs)).

## What you need to do

1. Fund the **deployer** `GNm79FtEQQx41LYfVbU9xDQaFDRVQyZ8q85DAWoHe6Bw` at <https://faucet.solana.com> (network: devnet).
   - **At least 1 SOL.** One run needs about 0.45 SOL; see Costs. 1 SOL leaves room for a re-run.
   - **About 4 SOL** if you also want the graduation step (`GRADUATE=1`).

   The scripts move SOL from the deployer to the launcher, buyer and owner, so this is the only address you fund.
2. Run:

```bash
cd programs/shop-vault
(cd client && npm ci)                        # once; the scripts load web3.js / pump-sdk 3.2.0 from client/node_modules
scripts/build.sh                             # optional: rebuilds both flavours, size + flavour gates
scripts/devnet-deploy.sh                     # deploys target/deploy-devnet/shop_vault.so, writes scripts/out/devnet-deploy.json
node scripts/devnet-e2e.ts                   # DRY_RUN: guards + simulation only
DRY_RUN=false node scripts/devnet-e2e.ts     # the real run (about 2 min; it waits out the 60 s claim window)
```

3. Copy into this file:
   - the lookup table address from `scripts/out/devnet-state.json`
   - the deploy cost from `scripts/out/devnet-deploy.json`
   - the signatures from `scripts/out/devnet-e2e-<time>.json`

   `scripts/out/` is gitignored.

## Addresses

The program id and PDAs are the same on every cluster.

| what | address |
|---|---|
| program (`.keys/shop-vault-program.json`) | `6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x` |
| ProgramData PDA | `ELrnhgeGxW5TcJZM6a29Gyxem4SLSiN4q2ReAtoJ7PMs` |
| Config PDA `["config"]` | `FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY` |
| CORNERSHOP lookup table | created by the first live e2e run (14 shared keys, then frozen); recorded in `scripts/out/devnet-state.json` |
| deployer = upgrade authority = **governance** (devnet) | `GNm79FtEQQx41LYfVbU9xDQaFDRVQyZ8q85DAWoHe6Bw` (`.keys/devnet-deployer.json`) |
| attestor (the Worker's co-signer; never funded) | `AR4W7wJSk76qpqXGJu5herEmFja8EGrzvjZLxiaF6Wty` (`.keys/devnet-attestor.json`) |
| guardian | `8FEurcTwYn1qBGGUuQQntBCVgkBtGgh6ZFx65vBNJnnG` (`.keys/devnet-guardian.json`) |
| launcher | `5XcrtCPB9NTYf6NiNKq398wUhJ4YTvA3TkK8HY4VL5cW` (`.keys/devnet-launcher.json`) |
| buyer (trader, and the stranger who cranks the fee collection) | `7sE52kx7kR5LwzhBfBjj3XNkXLXnFdQ7vonbzCbPuvM` (`.keys/devnet-buyer.json`) |
| owner (the phone-verified shop owner in the test) | `BmU3t68KBpUj1JRAc4HHKLka9YAmqtuVXFd2KoxbWKyt` (`.keys/devnet-owner.json`) |
| deploy write buffer | `8RT91n3uhk4zj111rZTKhn5gGfxHWbK4xeFUwL9BHZd` (`.keys/devnet-deploy-buffer.json`) |

The buffer is a keypair file so that a failed deploy never prints a recovery seed phrase; re-running the same command
resumes it.

- **Key file names.** They follow this workflow's naming (`devnet-<role>.json`), not the SPEC §11 sketch (`<role>-devnet.json`).
  `initialize_config` needs three distinct keys, so there is also a guardian key.
- **Governance.** It is the deployer, as in the mainnet runbook (SPEC §11 step 2).
- **Claim window.** 60 s. The devnet build accepts 60 s to 24 h.
- **Secrets.** No secret key was printed or logged.
- **Each run's place.** A fresh fictional id `cornershop-test:e2e-<time>`, never a real Google place id.

## Costs

**Devnet** figures use devnet rent (5,080 lamports per byte, 128-byte account header included; values read with
`getMinimumBalanceForRentExemption`) and the transaction counts measured in the rehearsal. The rehearsal ran at
LiteSVM/test-validator rent (6,960 lamports per byte), so its absolute rents are about 37% higher than devnet's.

| item | devnet | measured in rehearsal |
|---|---:|---:|
| program deploy, **rent locked** (ProgramData 35,973 B + program account 36 B) | **0.18422620 SOL** | 0.25240440 SOL |
| program deploy, peak needed in the deployer (the 35,965 B write buffer, 0.18335244 SOL, is refunded) | ≈ 0.368 SOL | — |
| program deploy, fees | ≈ 0.0002 SOL | 0.0002 SOL (200,000 lamports) |
| `initialize_config`: Config rent (256 B) + fee | 0.00195072 + 0.000005 SOL | 10,709 CU |
| lookup table: rent (504 B) + 2 fees | 0.00321056 + 0.00001 SOL | 20,404 + 1,517 CU |
| **one launch** with a 0.01 SOL dev buy, launcher's total | **≈ 0.0197 SOL** | 0.02328476 SOL |
| … of which shop-vault rent (VaultState 208 B + vault top-up) | 0.00235712 SOL | |
| … of which the dev buy | 0.01 SOL | |
| … of which the tx fee (3 signatures + priority) | 0.000019 SOL | 181,880–204,380 CU, **1,133 B** tx |
| fee-test trades (0.1 SOL v3 buy, sell half; 0.05 SOL v2 buy, sell a third) | about 0.15 SOL in flight; most comes back on the sells | |
| **total to fund (no graduation)** | **≈ 0.45 SOL minimum → ask for 1 SOL** (deploy net 0.184 + config/ALT 0.005 + top-ups 0.233 + 0.02 reserve; the 0.368 SOL deploy peak is below that) | |
| graduation (`GRADUATE=1`): buying out a fresh devnet curve | ≈ 2.8 SOL + fees | 2.795827426 SOL quoted |

These figures are consistent with the mainnet target: a 35,928 B binary locks about 0.184 SOL of rent at 5,080 lamports
per byte, and about 0.37 SOL is needed in the deployer during the deploy.

## What `scripts/devnet-e2e.ts` does

Every transaction is simulated with `sigVerify` before it is sent. A transaction that expires is rebuilt and re-signed
(including a fresh attestor co-signature), at most 3 attempts. Every signature is printed with an explorer link
(`https://explorer.solana.com/tx/<sig>?cluster=devnet`) and written to `scripts/out/devnet-e2e-<time>.json`.

**Guards.** The genesis hash must be devnet. Mainnet is refused outright, and both scripts were verified to refuse it.
`LOCALNET=1` allows only `http://127.0.0.1`. Keys are read only from `.keys/`.

**Steps:**

0. **Program check.** The program is deployed and its upgrade authority is the deployer.
1. **`initialize_config(attestor, governance = deployer, guardian, 60)`** if Config does not exist. It checks the
   `shop-vault-build:devnet` marker in `ConfigInitialized`, then `flavor`, the keys and the window.
2. **Lookup table.** It creates the CORNERSHOP lookup table (the 14 shared keys of SPEC §8.1), freezes it and checks it.
3. **Funding.** It tops up the launcher, buyer and owner from the deployer.
4. **The launch: one v0 transaction through the lookup table.** The pump `create_v2` has `creator` = vault PDA; then
   `register_launch`; then the ATA; then a 0.01 SOL `buy_exact_quote_in_v3` dev buy. The Worker-side step then:
   - decodes the message bytes;
   - runs the §8.4 launch policy (`checkLaunchMessage`);
   - co-signs as the attestor;
   - shows the policy refusing a copy whose `create_v2` name was changed.

   The mint and the launcher then sign. Checks after it lands:
   - size ≤ 1,232 B and exactly 3 signers;
   - VaultState fields;
   - `bonding_curve.creator == vault`;
   - the vault is system-owned, has 0 data and is rent-exempt;
   - the dev buy's TradeEvent names the vault.
5. **Trades and fee collection.**
   - The buyer does `buy_exact_quote_in_v3` 0.1 SOL, `sell_v3` (half), `buy_v2` 0.05 SOL and `sell_v2` (a third).
   - The buyer, acting as a stranger, then runs pump `sweep_creator_fee` + `collect_creator_fee(creator = vault)`.
   - Checks: **the vault's lamports rise by exactly Σ `TradeEvent.creator_fee`**, and the vault is still system-owned
     with no data.
6. **Claim and withdraw.**
   - `request_claim(owner, nonce 1)`: the §8.4 claim policy (`checkClaimMessage`) runs, then the attestor co-signs.
   - Refused in simulation: an owner `withdraw` before finalize gives `NoOwner` (125); `finalize_claim` inside the window
     gives `ClaimWindowActive` (122).
   - A **second launch for the same place** with a new mint, co-signed, is sent and **fails on-chain with
     `AlreadyRegistered` (110)**. The second mint and its curve do not exist.
   - It waits for the chain clock to pass `unlock_ts`, then runs `finalize_claim`.
   - A **non-owner `withdraw` is sent and fails on-chain with `NotOwner` (126)**.
   - The owner withdraws, with the deployer as relayer paying the fee. The owner receives **exactly**
     `vault − rent_min(0)`, which equals the collected fees. The vault is left at exactly `rent_min(0)`, system-owned.
     `total_withdrawn` is updated.
7. **Pause.** The guardian sends `set_paused(1)`, a launch simulates to `LaunchesPaused` (109), and the guardian sends
   `set_paused(0)`. Skip it with `PAUSE_TEST=false`.
8. **`GRADUATE=1`** (optional). The buyer buys out the curve with `buy_v3` for the remaining tokens. Checks: the curve is
   complete, and the graduation buy's creator fee is swept and collected into the vault. It then waits up to
   `GRADUATE_WAIT_MIN` (30) minutes for pump's migration bot to create the PumpSwap pool.

   Not implemented yet, so SPEC §13.5 step 7 stays open:
   - PumpSwap trades;
   - pump-amm `transfer_creator_fees_to_pump`;
   - `collect_coin_creator_fee` into a vault WSOL ATA, then `unwrap_wsol`.

Not covered on devnet: the SPEC §13.5 step 6 rotation and probation demo, and the nonce reuse after a cancel. Both are
covered by the LiteSVM tests (`ADM-*`, `CLM-03`, `CLM-14`).

## Rehearsal (localnet with devnet's pump programs)

`scripts/localnet-validator.sh` starts `solana-test-validator` with:
- `--clone-feature-set` and `--clone-upgradeable-program` for pump, pump_fees, mayhem and pump_amm, all **from devnet**;
- the devnet Global, FeeConfig, mayhem accounts, fee and buyback recipients and their WSOL ATAs;
- a local faucet.

Then:

```bash
scripts/localnet-validator.sh &        # wait for it, then:
solana -u http://127.0.0.1:8899 airdrop 20 GNm79FtEQQx41LYfVbU9xDQaFDRVQyZ8q85DAWoHe6Bw
LOCALNET=1 RPC_URL=http://127.0.0.1:8899 scripts/devnet-deploy.sh
LOCALNET=1 RPC_URL=http://127.0.0.1:8899 DRY_RUN=false node scripts/devnet-e2e.ts
```

**Results, 2026-10-08:** `devnet-deploy.sh` deployed the 35,928 B devnet build. The e2e then **passed in 3 consecutive
live runs (44 checks each)**. The third run had `GRADUATE=1` and the pause step off. The steps and figures:

| step | result |
|---|---|
| `initialize_config` | 10,709 CU |
| launch tx | 1,133 B, 3 signers, 181,880–204,380 CU, fee 19,000 lamports |
| v3 buy / v3 sell / v2 buy / v2 sell | 71.7k / 47.1k / 89.2k / 75.0k CU |
| Σ creator fees | 731,548 lamports: curve bucket 480,982 + `creator_vault` 250,566 above rent |
| sweep + collect by a stranger | 42,039 CU; vault +731,548 lamports, exactly Σ fees |
| `request_claim` | 1,982 CU |
| `finalize_claim` | 849 CU |
| owner `withdraw` | 4,117 CU; owner +731,548 lamports exactly; vault back to `rent_min(0)` |
| second launch | `AlreadyRegistered` (110) on-chain; mint absent |
| non-owner withdraw | `NotOwner` (126) on-chain |
| pause / unpause | 1,001 CU each; paused launch refused with `LaunchesPaused` (109) |

With `GRADUATE=1` the buy-out quoted and spent 2.7958 SOL (51,826 CU), the curve completed, and its fee was collected.
The pool did not appear locally, as expected, because the migration bot runs only on devnet.

The rehearsal signatures exist only on that throw-away validator, so they are not listed here. The reports are in
`scripts/out/localnet-e2e-*.json`.

Two findings from the rehearsal:

- **SBPF version.**
  - The build is SBPF v0 (ELF `e_flags = 0`). `solana-test-validator` turns on every feature by default, including
    SIMD-0500 ("disable deployment of SBPF v0, v1 and v2"), so the first local deploy was refused. Mirroring devnet's
    features fixed it.
  - On 2026-10-08, SIMD-0500 (`B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`) was **inactive on both devnet and
    mainnet**, so this binary deploys on both today. SBPF v3 deployment is already enabled on both.
  - **Before the mainnet deploy, and before any later upgrade, check `solana feature status
    B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g`.** Once SIMD-0500 is active, deploys and upgrades need an SBPF v3
    build (`cargo build-sbf --arch v3`, then re-run the size gate and the tests). Already-deployed programs keep running.
- **A dropped launch.** The very first launch, sent right after the lookup table was created and frozen, simulated
  fine but never landed: its blockhash expired. While the RPC retried it, the validator's banking-stage counters showed
  one sigverify-discarded packet each time. The cause is not pinned down. The same flow landed in every later run, and
  so did every isolated retry of launch-shaped transactions, co-signed or not, with or without the lookup table. The
  script now waits 3 slots after freezing the table, and it rebuilds, re-attests and resends an expired transaction
  (at most 3 attempts). An expired blockhash can never land later, so a retry cannot execute anything twice.

## Files

| path | role |
|---|---|
| `scripts/devnet-deploy.sh` | Guarded deploy with `--max-len` = binary size and `--use-rpc`. Runs `check-artifact.sh … devnet` first. Writes `scripts/out/<cluster>-deploy.json`. |
| `scripts/devnet-e2e.ts` | The e2e. Node ≥ 22.18 type stripping, `@pump-fun/pump-sdk` **3.2.0** (pinned in `client/package.json`). |
| `scripts/localnet-validator.sh`, `scripts/localnet-clone-keys.cjs` | Rehearsal chain, with pump cloned from devnet. |
| `scripts/package.json` | Marks `scripts/` as ESM. |
| `scripts/out/` (gitignored) | State (lookup table address), deploy and e2e reports. |


## Live e2e signatures (2026-10-08)
- launch: create_v2(creator = vault) + register_launch + dev buy, one co-signed v0 tx: https://explorer.solana.com/tx/4nJTvVVpTs856Ba6Si177N3CqCVEmQL11fmTRdjr2kYq75nQo719rhxk851mxW2hAkEGWY2jXyYLEg1bHudp3x3N?cluster=devnet
- stranger: pump sweep_creator_fee + collect_creator_fee(creator = vault): https://explorer.solana.com/tx/2ujz1C6ih39Ctz2iDxBNRi8tHHD8URboZH8sTaQZ5ZJptDqvAJAYjmV1bSwYGdNTmLeQncso9jHrBUqijtgGkcBF?cluster=devnet
- second launch for the same place (new mint, co-signed) -> AlreadyRegistered: https://explorer.solana.com/tx/uVBvJnRjwkQmznMyw8vxW8o2sWFjofYUwMX9u3JzAmt14hSr2Xs2TCqupgYxUv55eCH8G5QsnLcAmuzoopbXA5t?cluster=devnet
- owner withdraw (relayer pays the fee): https://explorer.solana.com/tx/Jrj98ywSXCQ2YiwT2cC7ykvtopFAcZSQZe67kH4DoGGx9QogsDMUC3J7Jx8THhbqomwDG6YbQgGB3R2xMVgAgWY?cluster=devnet
- non-owner (buyer) withdraw -> NotOwner: https://explorer.solana.com/tx/54hBqJ4bHneccbARBJAtAzJsbVBUfERRGQhkvhEacbLEzE1XnErbh2qtJ3e5mNPW9xzK9AWR4jvRwQvhoeX4GW7L?cluster=devnet

## Graduation run (2026-10-08 ~20:40 UTC, GRADUATE=1)
- E2E PASSED (46 checks): full flow again + buy-out of the curve (~2.80 SOL) + sweep/collect after graduation into the vault.
- NOT verified on devnet: pump's migration bot did not create the PumpSwap pool `4MhKxT85ohkLzvSyBeNHRynV5kaX9TLdA3ZdzgYJ29Ez` within 30 min (migration needs pump's `withdraw_authority`; we cannot migrate ourselves). Post-AMM creator fees (wSOL → `unwrap_wsol`) are covered by the LiteSVM tests against the real pump binaries only. Re-check later: `solana account 4MhKxT85ohkLzvSyBeNHRynV5kaX9TLdA3ZdzgYJ29Ez --url devnet`; if it appears, trade on PumpSwap and run `unwrap_wsol` + withdraw.
- Log: scripts/out/graduate-run.log
