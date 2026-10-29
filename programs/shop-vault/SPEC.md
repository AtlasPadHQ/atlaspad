# shop-vault: program specification (v1)

Status: **implemented; revised 2026-10-08 after adversarial reviews 1 and 2** (authority split, probation, bounded
cancels, devnet-binary guards; see §10 and the `review_*` regression tests) · Target: Pinocchio 0.11.2 (no Anchor),
`.so` < 40 KB (currently 35,928 B).
Inputs: `../../BRIEF.md` (Phase 2 sections and the COST DECISION), `../../research/solana-phase2.md` (internal notes, not
published), the pump IDLs in `@pump-fun/pump-sdk@3.2.0` (`src/idl/pump.json`, `pump_amm.json`) and an earlier pump.fun
integration.

The program does one job. Every Google place gets **one** pump.fun coin whose `creator` is a per-place vault. Only the
phone-verified owner can take SOL out of that vault, and only after a public 72 h window. There is **no admin
withdrawal path**.

---

## 0. Decisions at a glance

| # | Decision | Why (evidence) |
|---|---|---|
| D1 | **The pump `creator` is a system-owned, zero-data PDA `["vault", place_hash]` (the *ShopVault*).** State lives in a separate program-owned PDA `["vault_state", place_hash]` (*VaultState*). | A wallet-shaped creator is the shape pump handles everywhere. `create_v2` with an off-curve, system-owned PDA creator was **verified** by simulation (research #3). `collect_creator_fee` debits pump's system-owned `creator_vault`, so it must CPI `System::Transfer`, and that credits any writable account. pump's `admin_cto` docs say a creator that is "not a system-owned wallet … is skipped", while a system-owned creator is **paid its accrued balance** on a takeover. A program-owned data account as creator was never verified (research #13 ASSUMED). §4 gives the proving test. |
| D2 | **The attestation is the attestor key co-signing the transaction** (the attestor is a required `Signer` of `register_launch` and `request_claim`). An `Ed25519SigVerify` instruction read through the Instructions sysvar is **not used**. Both instructions read the Instructions sysvar only to require that they run at the top level and are the **only** shop-vault instruction of their transaction, so one co-signature authorizes exactly one launch or one claim (review 1). | **Measured** (§8.1, web3.js 1.99 + pump-sdk 3.2.0 builders, a lookup table holding only keys shared across launches): the atomic launch tx `create_v2 + ed25519 + register + ATA + buy_v3` is **1,298 B** for typical metadata, over the 1,232 B limit. The research figure of 1,130 B put per-mint keys in the ALT. The co-signed version is **1,126 B** (typical) and **1,169 B** (name 32, symbol 10, uri 100), so it fits. Co-signing also binds the *whole* tx (name/symbol/uri, dev buy, launcher, mint) to what the backend moderated. The blockhash gives a ~60-90 s expiry and the runtime blocks replays. It also removes the ed25519 offset-spoofing bug class from the program. The ed25519 variant is kept, fully specified, in Appendix A for when 4 KB v1 transactions are usable. |
| D3 | `register_launch` **verifies pump's post-state**: the canonical bonding-curve PDA of `mint` exists, is owned by pump, has the BondingCurve discriminator, `creator == vault`, SOL quote, no mayhem/cashback/holder-reward, not complete, and `real_quote_reserves == 0`. It does **not** CPI into `create_v2` and does **not** look for `create_v2` in the Instructions sysvar (it reads the sysvar only for the D2 scope check). | Checking post-state is stronger than checking `create_v2` arguments. For example, `is_holder_reward` silently overrides `creator`, and an args check would miss that. It depends only on the BondingCurve prefix (bytes 0..125), which pump has extended only by appending fields. A CPI would hard-wire the 16-account `create_v2` ABI (pump shipped three SDK majors on 2026-10-07). It would also nest Token-2022, ATA and mayhem CPIs under ours, add ~16 metas plus the strings to our ix, and bloat the binary. "Same tx" is guaranteed by the attestor signing the whole tx. On-chain, `real_quote_reserves == 0` proves nobody has traded the curve before registration. |
| D4 | **Claim and withdraw never read pump state and never CPI into pump.** | A pump upgrade or ABI change can break *new launches* (a safe failure) but can never lock money already in a vault. |
| D5 | **One coin per place, forever**: `VaultState` is created in the launch tx and never closed. A pre-funded PDA is adopted, not rejected (§5.1). | Enforced on-chain. A duplicate launch reverts the whole tx, so no orphan coin is created. Pre-funding a PDA cannot block a launch. |
| D6 | `cancel_claim` is allowed for the **guardian** (unlimited), **governance** (at most 2 per place, ever), the **pending claimant**, and the **current owner only for a claim requested during a probation** (D11). Never the attestor; never the owner otherwise. | Disputes are handled by us during the window. An owner veto outside probation would let a thief holding a stolen owner key block phone-verified recovery forever. Capping governance means a hostile or lost-quorum governance cannot freeze a shop forever (review 1); the guardian is uncapped because governance can replace it. |
| D7 | Extra instruction **`unwrap_wsol`** (permissionless, funds can only go *into* the vault). | pump-amm `collect_coin_creator_fee` has **no signer** (IDL 3.2.0). Anyone can push a graduated coin's WSOL creator fees into a WSOL token account owned by our vault. Without this instruction those fees would be stuck. |
| D8 | `withdraw` is signed by the owner and pays `vault.lamports − rent_min(0)` plus any `VaultState` surplus to `VaultState.owner`. Any fee payer may submit it. | Only the verified owner can trigger a payout, and the payout can only go to that owner. A relayer can pay the fee for an owner with 0 SOL. Stray SOL sent to the state PDA is not stranded. |
| D9 | **Three distinct keys** in Config (review 1). **Attestor** = online Worker key: co-signs `register_launch`/`request_claim` and has **no other power**. **Guardian** = offline ops key (or a watchdog service that is *not* the request-path Worker): pause, cancel claims, veto or consent to rotations, propose a governance recovery. **Governance** = Squads vault: proposes attestor/guardian rotations and governance handovers, pause, capped cancels. Attestor and guardian rotation: **governance proposes → the guardian consents (applies at once), or anyone applies after 7 days**. A guardian veto makes governance's next proposal of that kind **escalated**: 14 days and not vetoable. Governance handover is two-step, withdrawable and expires after 30 days; the guardian may propose a governance **recovery** that the new key can accept after 30 days unless governance withdraws it. | Lost or compromised attestor: governance + guardian rotate it at once. Lost guardian: governance replaces it in 7 days. Hostile guardian: at most one veto per kind, so governance replaces it in ≤ 21 days. Lost governance: guardian recovery in 30 days. **Governance is the root of trust**: a compromised governance can eventually take over, but only slowly and in public (D11, T11). |
| D10 | Claim window: set once in `initialize_config`, bounded by compile-time constants. The mainnet build has 72 h ≤ window ≤ 30 d; the `devnet` feature has 60 s ≤ window ≤ **24 h**. There is no setter. Config records the build (`flavor`, `rotation_delay_secs`) and `ConfigInitialized` carries the marker `shop-vault-build:mainnet`/`:devnet`. The devnet build goes to its own `target/deploy-devnet/`. | A mainnet binary can never run with a window shorter than 72 h, and a devnet binary (300 s rotation delay) refuses the mainnet runbook's 259,200 s window, so it cannot pass for a mainnet deploy (review 2, R2-A3). |
| D11 | **Probation**: every attestor change sets `probation_until = max(probation_until, now + 7 d)`. A claim requested before `probation_until` gets `unlock_ts = probation_until + window` and is flagged so the shop's current owner may cancel it. | A rogue attestor installed by governance (directly, or through a guardian it installed) cannot finalize anything for ≥ 7 d + window, and owners can block its claims meanwhile (review 2, R2-A1). Applies to consented rotations too, so a governance-installed guardian's "consent" buys nothing. |

---

## 1. Invariants (what reviewers must be able to confirm)

- **I1** Lamports leave a ShopVault **only** in `withdraw`, by `System::Transfer` signed with the vault seeds, to `VaultState.owner`, and never below `Rent::minimum_balance(0)`.
- **I2** Lamports leave a VaultState **only** in `withdraw`, as the surplus above `Rent::minimum_balance(VAULT_STATE_LEN)`, to `VaultState.owner`.
- **I3** `VaultState.owner` changes **only** in `finalize_claim`, to a `pending_owner` that was set by an attestor-co-signed and new-owner-signed `request_claim` at least `claim_window_secs` earlier and was not cancelled.
- **I4** For a given `place_hash` at most one VaultState exists, and it is never closed or reassigned to another mint.
- **I5** The vault seeds sign exactly two CPI kinds: `System::Transfer{from: vault, to: owner}` in `withdraw`, and `Token::CloseAccount{dest: vault, authority: vault}` in `unwrap_wsol`. The vault never signs anything for pump, so nobody can create a fee-sharing config for our coins (pump error 6016).
- **I6** `paused` affects only `register_launch`.
- **I7** No instruction reads pump accounts except `register_launch`, and the program never CPIs into pump.
- **I8** No admin instruction (guardian or governance) moves lamports. The only other lamport movements are rent and the vault top-up paid by the signer in `initialize_config`/`register_launch`, and `unwrap_wsol`, which pays only *into* the vault.
- **I9** The attestor's signature authorizes only `register_launch` and `request_claim`, each only at the top level of a transaction that contains no other shop-vault instruction. The attestor key has no admin power.
- **I10** Attestor, guardian and governance are always three distinct non-zero keys.
- **I11** Governance cancels at most `MAX_GOVERNANCE_SOLO_CANCELS` (2) claims per place, ever. Every attestor change starts a probation (D11).

---

## 2. Constants

```text
PROGRAM_ID                = <.keys/shop-vault-program.json pubkey>   (same id on devnet and mainnet)
SYSTEM_PROGRAM            = 11111111111111111111111111111111
SPL_TOKEN_PROGRAM         = TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
NATIVE_MINT (WSOL)        = So11111111111111111111111111111111111111112
BPF_LOADER_UPGRADEABLE    = BPFLoaderUpgradeab1e11111111111111111111111
PUMP_PROGRAM              = 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P   (mainnet = devnet address)
BONDING_CURVE_DISC        = 17 b7 f8 37 60 d8 ac 60   (= sha256("account:BondingCurve")[..8], verified)
BONDING_CURVE_MIN_LEN     = 125

# reference only (used by clients and tests, not by the program)
PUMP_FEES   = pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ     PUMP_AMM = pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
MAYHEM      = MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e     TOKEN_2022 = TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
pump Global = 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf    pump FeeConfig = 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt
create_v2 d6904cec5f8b31b4 · collect_creator_fee 1416567bc61cdb84 · sweep_creator_fee 20f6bf3408c949ba
buy_exact_quote_in_v3 e1f7501ed5b38488   (all = sha256("global:<name>")[..8], verified)
genesis: devnet EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG · mainnet 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
```

Build-profile constants (cargo feature `devnet`; the default build is mainnet):

| const | mainnet (default) | `--features devnet` |
|---|---|---|
| `MIN_CLAIM_WINDOW_SECS` | 259,200 (72 h) | 60 |
| `MAX_CLAIM_WINDOW_SECS` | 2,592,000 (30 d) | **86,400 (24 h)**, below the mainnet minimum |
| `ROTATION_DELAY_SECS` (attestor and guardian) | 604,800 (7 d) | 300 |
| `ESCALATED_ROTATION_DELAY_SECS` (= 2 × rotation delay) | 1,209,600 (14 d) | 600 |
| `PROBATION_SECS` (= rotation delay) | 604,800 (7 d) | 300 |
| `GOVERNANCE_RECOVERY_DELAY_SECS` | 2,592,000 (30 d) | 900 |
| `GOVERNANCE_ACCEPT_WINDOW_SECS` | 2,592,000 (30 d) | 2,592,000 |
| `MAX_GOVERNANCE_SOLO_CANCELS` (per place, ever) | 2 | 2 |
| `FLAVOR` / marker | 0 / `shop-vault-build:mainnet` | 1 / `shop-vault-build:devnet` |
| `INSTRUCTIONS_SYSVAR` | `Sysvar1nstructions1111111111111111111111111` | same |

BondingCurve byte offsets (pump IDL 3.2.0; the program reads only bytes 0..125):

| off | len | field | program check |
|---:|---:|---|---|
| 0 | 8 | discriminator | `== BONDING_CURVE_DISC` |
| 32 | 8 | `real_quote_reserves` u64 | `== 0` (nobody has traded yet) |
| 48 | 1 | `complete` | `== 0` |
| 49 | 32 | `creator` | `== vault` |
| 81 | 1 | `is_mayhem_mode` | `== 0` |
| 82 | 1 | `is_cashback_coin` | `== 0` |
| 83 | 32 | `quote_mint` | `== [0;32]` **or** `== NATIVE_MINT` (the SDK treats both as SOL, `pda.ts:177`) |
| 124 | 1 | `is_holder_reward` | `== 0` |

(Further fields are `creator_fee_bps`@115, `creator_fee` bucket@125, `protocol_fees`@133, `depth`@141 and so on. They are not read.)

---

## 3. Accounts

### 3.1 Keys and hashing

- `place_hash = sha256(utf8(placeId))`. `placeId` is the bare Places API (New) `place.id` (e.g. `ChIJN1t_tDeuEmsRUsoyG83frY4`), with no `places/` prefix and no trimming or normalisation.
  Test vector: `sha256("ChIJN1t_tDeuEmsRUsoyG83frY4") = 52791f4bf8f035bc928405e161a4c28a262db717cfe91ae8d3615563066afa15`.
- The program never sees `placeId`. The backend computes the hash from the place it looked up itself.

| account | seeds (program = PROGRAM_ID) | owner | size | rent (mainnet 5,080 lamports/B incl. 128 B header) |
|---|---|---|---:|---:|
| Config | `["config"]` | PROGRAM_ID | 256 | 1,950,720 (0.00195 SOL, once) |
| ShopVault (pump `creator`) | `["vault", place_hash]` | **System** | 0 | 650,240 (kept forever) |
| VaultState | `["vault_state", place_hash]` | PROGRAM_ID | 208 | 1,706,880 |

The launcher pays ≈ **0.00236 SOL** per launch for our two accounts. The program always reads `Rent` from the sysvar and never hard-codes these numbers; devnet and LiteSVM rents differ.

All integers are little-endian. Every layout is `#[repr(C)]` over byte arrays (no alignment assumptions) and is read and written by fixed offsets. A "zero key" is `[0u8; 32]`.

### 3.2 Config (`CONFIG_LEN = 256`)

The attestor and the guardian are each a 72-byte rotation slot `{current:32, pending:32, eta:i64}` (one code path).

| off | len | field | notes |
|---:|---:|---|---|
| 0 | 1 | `tag` | `1` (TAG_CONFIG) |
| 1 | 1 | `version` | `1` |
| 2 | 1 | `bump` | canonical bump of `["config"]` |
| 3 | 1 | `paused` | `0`/`1`; blocks `register_launch` only |
| 4 | 1 | `flavor` | `0` mainnet build, `1` devnet build (set at init from the binary) |
| 5 | 1 | `flags` | bit0 `ATTESTOR_VETOED`, bit1 `GUARDIAN_VETOED` (the pending/next proposal of that kind is escalated), bit2 `GOVERNANCE_BY_GUARDIAN` (the pending governance proposal is a guardian recovery) |
| 6 | 2 | `_pad0` | zero |
| 8 | 32 | `attestor.current` | online key that co-signs launches and claims; never funded, never writable, no admin power |
| 40 | 32 | `attestor.pending` | zero = no proposal |
| 72 | 8 | `attestor.eta` i64 | from this time anyone may apply the proposal; 0 = none |
| 80 | 32 | `guardian.current` | offline ops key (devnet: a local key) |
| 112 | 32 | `guardian.pending` | zero = no proposal |
| 144 | 8 | `guardian.eta` i64 | |
| 152 | 32 | `governance` | devnet: a local key; mainnet: Squads vault PDA |
| 184 | 32 | `pending_governance` | zero = none |
| 216 | 8 | `pending_governance_eta` i64 | acceptable in `[eta, eta + 30 d)`; handover: eta = proposal time; recovery: + 30 d |
| 224 | 8 | `claim_window_secs` i64 | fixed at init, `MIN..=MAX` |
| 232 | 8 | `probation_until` i64 | 0 = never; raised by every attestor change (D11) |
| 240 | 8 | `rotation_delay_secs` i64 | `ROTATION_DELAY_SECS` of the initialising build (informational) |
| 248 | 8 | `_reserved` | zero |

### 3.3 VaultState (`VAULT_STATE_LEN = 208`)

| off | len | field | notes |
|---:|---:|---|---|
| 0 | 1 | `tag` | `2` (TAG_VAULT_STATE) |
| 1 | 1 | `version` | `1` |
| 2 | 1 | `state_bump` | canonical |
| 3 | 1 | `vault_bump` | canonical bump of `["vault", place_hash]` |
| 4 | 1 | `has_owner` | `0`/`1` |
| 5 | 1 | `has_pending` | `0`/`1` |
| 6 | 1 | `governance_cancels` | claims governance cancelled here, ever (≤ 2) |
| 7 | 1 | `pending_flags` | bit0 `IN_PROBATION`: the pending claim was requested during a probation, so the owner may cancel it; 0 unless `has_pending` |
| 8 | 32 | `place_hash` | |
| 40 | 32 | `mint` | the official coin |
| 72 | 32 | `launcher` | |
| 104 | 32 | `owner` | zero unless `has_owner` |
| 136 | 32 | `pending_owner` | zero unless `has_pending` |
| 168 | 8 | `unlock_ts` i64 | 0 unless `has_pending` |
| 176 | 8 | `claim_nonce` u64 | last consumed nonce (starts at 0) |
| 184 | 8 | `total_withdrawn` u64 | lamports paid out, ever |
| 192 | 8 | `created_at` i64 | |
| 200 | 8 | `owner_since` i64 | 0 unless `has_owner` |

### 3.4 ShopVault

ShopVault has no data and is owned by the System Program. Its lamports are the shop's money. Anyone may credit it (pump `collect_creator_fee`, donations). Only `withdraw` debits it. `register_launch` tops it up to `rent_min(0)` so that pump's first `System::Transfer` into it can never fail the rent-state check.

### 3.5 Loading helpers (used by every instruction)

- `load_config(acc)`: `acc.owner == PROGRAM_ID`, `data_len == CONFIG_LEN`, `tag == 1`, `version == 1`, or `InvalidConfig`. Only `initialize_config` creates an account with this tag, and only at the canonical `["config"]` address, so a matching owner and tag prove authenticity.
- `load_state(acc, writable)`: `acc.owner == PROGRAM_ID`, `data_len == VAULT_STATE_LEN`, `tag == 2`, `version == 1`, and `is_writable` if required, or `InvalidVaultState`. Only `register_launch` creates these, at the canonical PDA.
- `check_vault(acc, state)`: `acc.key == create_program_address(["vault", state.place_hash, [state.vault_bump]], PROGRAM_ID)`, `acc.owner == SYSTEM_PROGRAM`, `data_len == 0`, `is_writable`, or `InvalidVault`. The **address check is mandatory**, because ownership cannot authenticate a system account.
- Bumps are never taken from instruction data. They are derived with `find_program_address` at creation, stored, and reused with `create_program_address`.

---

## 4. Why ShopVault is system-owned, and the test that proves it

How pump pays creator fees (SOL-quoted coins):

1. `buy_v3`/`sell_v3`/`buy_exact_quote_in_v3` put the creator fee in `BondingCurve.creator_fee` (a pump-owned account). The permissionless `sweep_creator_fee` moves it into `creator_vault = PDA(["creator-vault", creator], pump)`.
2. v1/v2 trades pay `creator_vault` directly.
3. `creator_vault` is **system-owned with zero data** (verified on mainnet, research §2.2). The runtime lets only the owner (the System Program) debit it, so `collect_creator_fee` must `invoke_signed(System::Transfer{from: creator_vault, to: creator})`. That credits **any writable account**, whatever its owner.
4. After graduation, `pump_amm::transfer_creator_fees_to_pump` (no signer) unwraps the AMM WSOL vault into the same pump `creator_vault`, and then step 3 applies. The other path, `pump_amm::collect_coin_creator_fee` (also no signer), pays WSOL into a token account of the creator. `unwrap_wsol` handles that case.

So both options would *probably* receive fees. The system-owned PDA is still the **safe choice**:

- (a) It is exactly the shape that was verified for `create_v2` and the shape every wallet creator has. Any current or future pump check such as Anchor `SystemAccount<'info>` on `creator` passes.
- (b) pump's `admin_cto` skips program-owned creators but **pays a system-owned creator** its accrued vault balance.
- (c) System transfer semantics are simple: no data means it cannot hold state that pump might misread.
- Cost: one extra 0-byte account per shop (650,240 lamports) and a CPI for withdrawals.

**Proving test (gate before any devnet deploy): `FEE-01`/`FEE-02` in §13.** They use the real mainnet `pump.so` and `pump_fees.so` in LiteSVM: create with `creator = vault`, trade from a second wallet (v3 and v2), `sweep_creator_fee` (v3), then `collect_creator_fee(creator = vault)` with a stranger as fee payer. They assert that `vault.lamports` rose by exactly the creator fee reported in the `TradeEvent`s, that `vault.owner == System` and `data_len == 0` still hold, and that `withdraw` then pays exactly that delta to the owner. `FEE-03` runs the same flow with a program-owned data account as creator and **records** the outcome. It is not a gate; it documents the alternative. The devnet E2E (§13.5) repeats FEE-01 against the live programs.

---

## 5. Instructions

Encoding: byte 0 is the discriminator, followed by fixed-size args. Data length must match **exactly**, otherwise
`InvalidInstruction`. Extra trailing accounts are ignored, and missing ones give `NotEnoughAccountKeys`. `S` = must be a
signer, `W` = must be writable. Every listed check happens **before** any CPI or write. `now = Clock::get().unix_timestamp`.

| disc | instruction | who | data len |
|---:|---|---|---:|
| 0 | `initialize_config` | upgrade authority, once | 105 |
| 1 | `register_launch` | launcher + attestor (alone in its tx) | 33 |
| 2 | `request_claim` | new owner + attestor (alone in its tx) | 9 |
| 3 | `cancel_claim` | guardian / governance (≤ 2 per place) / pending claimant / owner (probation claims) | 1 |
| 4 | `finalize_claim` | anyone | 1 |
| 5 | `withdraw` | owner | 1 |
| 6 | `unwrap_wsol` | anyone | 1 |
| 7 | `set_paused` | guardian / governance | 2 |
| 8 | `propose_attestor` | governance | 33 |
| 9 | `accept_attestor` | guardian (now) / anyone (after eta) | 1 |
| 10 | `cancel_attestor_proposal` | governance (withdraw) / guardian (veto, not escalated) | 1 |
| 11 | `propose_governance` | governance (handover; zero key withdraws) / guardian (recovery; zero key withdraws its own) | 33 |
| 12 | `accept_governance` | pending governance, in `[eta, eta + 30 d)` | 1 |
| 13 | `propose_guardian` | governance | 33 |
| 14 | `accept_guardian` | guardian (now) / anyone (after eta) | 1 |
| 15 | `cancel_guardian_proposal` | governance (withdraw) / guardian (veto, not escalated) | 1 |

### 5.0 `initialize_config` (disc 0)

Data: `[0] attestor:[u8;32] governance:[u8;32] guardian:[u8;32] claim_window_secs:i64` (105 B)

| # | account | S | W | |
|---:|---|:-:|:-:|---|
| 0 | payer | ✓ | ✓ | must be the program's upgrade authority |
| 1 | config | | ✓ | `["config"]` |
| 2 | program_data | | | `PDA([PROGRAM_ID], BPF_LOADER_UPGRADEABLE)` |
| 3 | system_program | | | |

Checks:
1. `payer` is a signer and writable (`MissingRequiredSignature` / `AccountNotWritable`).
2. `program_data.key == find_program_address([PROGRAM_ID], BPF_LOADER_UPGRADEABLE)`, `owner == BPF_LOADER_UPGRADEABLE`, `data_len ≥ 45`, `data[0..4] == 3u32` (ProgramData), `data[12] == 1` (`Some`), and `data[13..45] == payer.key`, otherwise `NotUpgradeAuthority`. Without this check anyone could front-run the init right after deploy and install their own attestor.
3. `config.key == find_program_address(["config"])`, otherwise `InvalidConfig`. If `config.owner == PROGRAM_ID`, fail with `AlreadyInitialized`.
4. `attestor`, `governance`, `guardian` all `≠ 0` and pairwise distinct, otherwise `InvalidAuthorityKey`.
5. `MIN_CLAIM_WINDOW_SECS ≤ claim_window_secs ≤ MAX_CLAIM_WINDOW_SECS`, otherwise `InvalidWindow`.
6. `system_program.key == SYSTEM_PROGRAM`, otherwise `InvalidSystemProgram`.

Effects: `create_or_adopt(config, CONFIG_LEN, payer, ["config", bump])` (§5.1). Write all fields with `paused = 0`, `flavor = FLAVOR`, `rotation_delay_secs = ROTATION_DELAY_SECS`, and the flags, pending fields and `probation_until` zeroed. Event `ConfigInitialized` (with the build marker).

### 5.1 `create_or_adopt` helper (shared by 5.0 and 5.2)

```text
need = Rent::get().minimum_balance(LEN)
if acc.owner == PROGRAM_ID           -> caller-specific error (AlreadyInitialized / AlreadyRegistered)
require acc.owner == SYSTEM_PROGRAM && acc.data_len == 0      else InvalidAccountState
if acc.lamports == 0:
    System::CreateAccount{from: payer, to: acc, lamports: need, space: LEN, owner: PROGRAM_ID}  signed [seeds]
else:   # someone pre-funded the PDA to grief CreateAccount (it fails with AccountAlreadyInUse)
    if acc.lamports < need: System::Transfer{from: payer, to: acc, need - acc.lamports}
    System::Allocate{acc, LEN} signed [seeds];  System::Assign{acc, PROGRAM_ID} signed [seeds]
```

### 5.2 `register_launch` (disc 1)

Data: `[1] place_hash:[u8;32]`

| # | account | S | W | |
|---:|---|:-:|:-:|---|
| 0 | launcher | ✓ | ✓ | pays rent; fee payer of the launch tx |
| 1 | attestor | ✓ | | `== config.attestor` |
| 2 | config | | | |
| 3 | vault_state | | ✓ | `["vault_state", place_hash]` |
| 4 | vault | | ✓ | `["vault", place_hash]` = the pump `creator` |
| 5 | mint | | | the coin created by `create_v2` earlier in this tx |
| 6 | bonding_curve | | | `PDA(["bonding-curve", mint], PUMP_PROGRAM)` |
| 7 | system_program | | | |
| 8 | instructions_sysvar | | | `Sysvar1nstructions1111111111111111111111111` |

Checks, in order:
1. `load_config`. If `paused == 1`, fail with `LaunchesPaused`.
2. `launcher` is a signer and writable. `attestor` is a signer (`MissingRequiredSignature`) and `attestor.key == config.attestor` (`AttestorMismatch`).
2b. **Attestor scope**: `instructions_sysvar.key == INSTRUCTIONS_SYSVAR` (`InvalidInstructionsSysvar`), the current top-level instruction is this program, and no other top-level instruction of the transaction calls this program (`AttestorScope`). This also refuses a CPI into `register_launch`.
3. `(s, sb) = find_program_address(["vault_state", place_hash])` and `vault_state.key == s`, otherwise `InvalidVaultState`. If `vault_state.owner == PROGRAM_ID`, fail with **`AlreadyRegistered`**. It must be writable.
4. `(v, vb) = find_program_address(["vault", place_hash])` and `vault.key == v`, otherwise `InvalidVault`. It must be writable, `owner == SYSTEM_PROGRAM` and `data_len == 0`, otherwise `InvalidVault`.
5. `bonding_curve.owner == PUMP_PROGRAM`, `bonding_curve.key == find_program_address(["bonding-curve", mint.key], PUMP_PROGRAM)`, `data_len ≥ 125` and `data[0..8] == BONDING_CURVE_DISC`, otherwise `InvalidBondingCurve`.
6. `curve.creator == vault.key`, otherwise `CreatorMismatch`.
7. `complete == 0`, `is_mayhem_mode == 0`, `is_cashback_coin == 0`, `is_holder_reward == 0`, and `quote_mint ∈ {0, NATIVE_MINT}`, otherwise `UnsupportedCurve`.
8. `real_quote_reserves == 0`, otherwise `CurveNotFresh`. The dev buy must come **after** this instruction.
9. `system_program.key == SYSTEM_PROGRAM`, otherwise `InvalidSystemProgram`.

Effects:
1. `create_or_adopt(vault_state, VAULT_STATE_LEN, launcher, ["vault_state", place_hash, [sb]])`.
2. `m0 = Rent::minimum_balance(0)`. If `vault.lamports < m0`, `System::Transfer{launcher → vault, m0 − vault.lamports}`. A pre-funded vault is fine.
3. Write the VaultState: tag, version, `sb`, `vb`, `place_hash`, `mint`, `launcher`, `created_at = now`, and zero for everything else.
4. Event `Registered`.

Config is **read-only** here, so launches never contend for a write lock on it.

### 5.3 `request_claim` (disc 2)

Data: `[2] nonce:u64`

| # | account | S | W | |
|---:|---|:-:|:-:|---|
| 0 | attestor | ✓ | | `== config.attestor` |
| 1 | new_owner | ✓ | | the phone-verified payout wallet (signing proves the owner controls it) |
| 2 | config | | | |
| 3 | vault_state | | ✓ | |
| 4 | instructions_sysvar | | | |

The fee payer may be `new_owner` or a relayer. The fee payer is not an instruction account.

Checks:
1. `load_config`. The attestor is a signer and matches (`MissingRequiredSignature` / `AttestorMismatch`). `new_owner` is a signer. Attestor scope as in §5.2 check 2b (`InvalidInstructionsSysvar` / `AttestorScope`).
2. `load_state(vault_state, W)`.
3. If `has_pending == 1`, fail with `ClaimAlreadyPending`.
4. `nonce == claim_nonce.checked_add(1)`, otherwise `BadNonce`.
5. `new_owner ∉ {attestor, governance, guardian}`, otherwise `InvalidOwner`. If `has_owner && owner == new_owner`, fail with `SameOwner`.
6. Probation (D11): if `now < probation_until`, `unlock = probation_until + claim_window_secs` and `pending_flags = IN_PROBATION`; otherwise `unlock = now + claim_window_secs` and `pending_flags = 0` (`ArithmeticOverflow` on overflow).

Effects: `pending_owner = new_owner`, `unlock_ts = unlock`, `has_pending = 1`, `pending_flags`, `claim_nonce = nonce`. Event `ClaimRequested`.
`paused` is ignored. **Re-claims of an owned shop are allowed**, for a lost wallet or a sale. The current owner keeps
receiving withdrawals until finalization, and disputes go to the guardian or governance (D6).

### 5.4 `cancel_claim` (disc 3)

Data: `[3]`. Accounts: `0 authority (S)`, `1 config`, `2 vault_state (W)`.

Checks: `load_config`, `load_state(W)`, `authority` is a signer. If `has_pending == 0`, fail with `NoPendingClaim`. If `now ≥ unlock_ts`, fail with
`ClaimWindowElapsed`. Then the first matching role:
- `authority == guardian` → role 0 (no limit: governance can replace a hostile guardian);
- `authority == governance` → role 1, only while `governance_cancels < 2` (else `GovernanceCancelLimit`), then `governance_cancels += 1`;
- `authority == pending_owner` → role 2;
- `has_owner && authority == owner && pending_flags & IN_PROBATION` → role 3;
- otherwise `Unauthorized` (this includes the attestor).

Effects: clear `pending_owner`, `unlock_ts`, `pending_flags` and `has_pending`. `claim_nonce` stays consumed. Event `ClaimCancelled{by_role}`.

### 5.5 `finalize_claim` (disc 4)

Data: `[4]`. Accounts: `0 vault_state (W)`. Permissionless; a crank or the new owner calls it.

Checks: `load_state(W)`. If `has_pending == 0`, fail with `NoPendingClaim`. If `now < unlock_ts`, fail with `ClaimWindowActive`. Cancel and finalize split time
cleanly: cancel works while `now < unlock_ts`, finalize while `now ≥ unlock_ts`.

Effects: `owner = pending_owner`, `has_owner = 1`, `owner_since = now`, then clear the pending fields (including `pending_flags`). Event `ClaimFinalized`.

### 5.6 `withdraw` (disc 5)

Data: `[5]`.

| # | account | S | W | |
|---:|---|:-:|:-:|---|
| 0 | owner | ✓ | ✓ | `== state.owner`; receives the funds |
| 1 | vault_state | | ✓ | |
| 2 | vault | | ✓ | |
| 3 | system_program | | | |

Checks: `load_state(W)`. If `has_owner == 0`, fail with `NoOwner`. `owner` is a signer and writable, and `owner.key == state.owner`, otherwise `NotOwner`.
`check_vault`. `system_program.key == SYSTEM_PROGRAM`.

Effects:
```text
a = vault.lamports.saturating_sub(Rent::minimum_balance(0))
b = vault_state.lamports.saturating_sub(Rent::minimum_balance(VAULT_STATE_LEN))
if a == 0 && b == 0 -> NothingToWithdraw
if a > 0: System::Transfer{from: vault, to: owner, a}  signed ["vault", place_hash, [vault_bump]]
if b > 0: vault_state.lamports -= b; owner.lamports += b   (direct; program owns vault_state; checked)
total_withdrawn = total_withdrawn.checked_add(a + b)            else ArithmeticOverflow
```
Event `Withdrawn{amount: a+b, total}`. Withdrawals work while paused and while a claim is pending. The fee payer may be a relayer.
Release every data borrow before the CPI, because Pinocchio checks borrow state on invoke.

### 5.7 `unwrap_wsol` (disc 6)

Data: `[6]`. Accounts: `0 vault_state`, `1 vault (W)`, `2 wsol_account (W)`, `3 token_program`. Permissionless.

Checks: `load_state`, `check_vault`, `token_program.key == SPL_TOKEN_PROGRAM` (`InvalidTokenProgram`).
`wsol_account.owner == SPL_TOKEN_PROGRAM`, `data_len == 165`, `data[0..32] == NATIVE_MINT`, `data[32..64] == vault.key`,
`data[108] == 1` (Initialized) and `data[109..113] == [1,0,0,0]` (`is_native = Some`), otherwise `InvalidTokenAccount`.

Effects: `invoke_signed(Token::CloseAccount)`, with data `[9]` and accounts `[wsol_account W, vault W (destination), vault S (authority)]`,
signed with the vault seeds. All lamports (rent plus wrapped SOL) land **in the vault**. Event `Unwrapped{amount}`.
Hand-encode the CPI; do not add a token crate.

### 5.8 Admin (discs 7-15)

All of these take `0 authority (S)`, `1 config (W)` and run `load_config` first (data length is checked before anything
else). None of them can touch a VaultState or move lamports. "Distinct" means attestor, governance and guardian stay
three different keys (I10), checked at proposal **and** again when applied.

| disc | data | rule | errors |
|---:|---|---|---|
| 7 `set_paused` | `[7] paused:u8` | authority ∈ {guardian, governance}; `paused ∈ {0,1}` | `Unauthorized`, `InvalidInstruction` |
| 8 `propose_attestor` / 13 `propose_guardian` | `[d] new:[u8;32]` | governance only; `new ≠ 0`, distinct; `pending = new`, `eta = now + 7 d` (**14 d if the guardian vetoed the previous proposal of this kind** = escalated); overwrites an earlier proposal | `Unauthorized`, `InvalidAuthorityKey`, `ArithmeticOverflow` |
| 9 `accept_attestor` / 14 `accept_guardian` | `[d]` | a proposal must exist; if `authority == guardian` apply now (consent), else require `now ≥ eta`; distinct; `current = pending`, clear pending and this kind's veto flag. **Attestor only:** `probation_until = max(probation_until, now + 7 d)` | `NoPendingRotation`, `RotationNotReady`, `InvalidAuthorityKey` |
| 10 `cancel_attestor_proposal` / 15 `cancel_guardian_proposal` | `[d]` | governance: withdraw. Guardian: veto, refused if this kind's veto flag is already set (`ProposalEscalated`); a veto sets the flag | `Unauthorized`, `NoPendingRotation`, `ProposalEscalated` |
| 11 `propose_governance` | `[11] new:[u8;32]` | governance: `new ≠ 0` → handover (`eta = now`), `new == 0` → withdraw any pending proposal. Guardian: `new ≠ 0` → recovery (`eta = now + 30 d`, flag `GOVERNANCE_BY_GUARDIAN`), `new == 0` → withdraw its own recovery only. `new` distinct from all three current keys. A new proposal overwrites the pending one | `Unauthorized`, `InvalidAuthorityKey`, `NoPendingGovernance` |
| 12 `accept_governance` | `[12]` | signer `== pending_governance` and not the attestor or guardian; `eta ≤ now < eta + 30 d`. Effects: `governance = pending`; **clear every pending attestor/guardian proposal and every flag** (review 1: a compromised governance's proposals must not survive the handover) | `NoPendingGovernance`, `Unauthorized`, `RotationNotReady`, `ProposalExpired` |

**Runbooks** (all on-chain steps are public; the Worker cron alerts on every `AdminChanged`, `ClaimRequested` without a
D1 row, and `ClaimCancelled`):
- **Compromised or lost attestor** (hot Worker key): guardian `set_paused(1)`; guardian cancels every rogue pending claim
  before its `unlock_ts`; governance `propose_attestor(new)` + guardian `accept_attestor` (same or separate tx: the old
  attestor cannot interfere); update the Worker secret; guardian `set_paused(0)`. New claims sit in a 7-day probation.
- **Compromised guardian:** governance `propose_guardian(new)`. If the guardian vetoes, propose again: the escalated
  proposal applies after 14 days and cannot be vetoed. Meanwhile governance unpauses as needed and the claimant can
  re-request any claim the hostile guardian cancels after the swap. **Lost guardian:** propose; anyone applies after 7 days.
- **Compromised governance (root of trust, T11):** guardian vetoes every attestor/guardian proposal once (the next one
  is escalated) and cancels every rogue claim; ops warn owners to withdraw; nothing on-chain can remove a live hostile
  governance. **Lost governance:** guardian `propose_governance(recovery)`; the recovery key accepts after 30 days.
- **Governance handover:** `propose_governance(new)` → `accept_governance` by `new` within 30 days. This clears every
  pending rotation; re-propose anything still wanted. Withdraw a mistaken proposal with the zero key.
- **Routine rotation:** governance proposes, the guardian consents. Pending claims are not touched by a rotation.

## 6. Errors (`ProgramError::Custom(n)`; built-in `MissingRequiredSignature`, `NotEnoughAccountKeys` and `InvalidInstructionData` are used where noted)

Custom codes start at 100 so they never collide with System Program CPI errors (0..=8).

| code | name | code | name | code | name |
|---:|---|---:|---|---:|---|
| 100 | InvalidInstruction | 112 | InvalidBondingCurve | 124 | Unauthorized |
| 101 | InvalidConfig | 113 | CreatorMismatch | 125 | NoOwner |
| 102 | InvalidVaultState | 114 | UnsupportedCurve | 126 | NotOwner |
| 103 | InvalidVault | 115 | InvalidSystemProgram | 127 | NothingToWithdraw |
| 104 | NotUpgradeAuthority | 116 | CurveNotFresh | 128 | ArithmeticOverflow |
| 105 | AlreadyInitialized | 117 | ClaimAlreadyPending | 129 | NoPendingRotation |
| 106 | InvalidWindow | 118 | NoPendingClaim | 130 | RotationNotReady |
| 107 | InvalidAuthorityKey | 119 | BadNonce | 131 | NoPendingGovernance |
| 108 | AttestorMismatch | 120 | SameOwner | 132 | InvalidTokenProgram |
| 109 | LaunchesPaused | 121 | InvalidOwner | 133 | InvalidTokenAccount |
| 110 | AlreadyRegistered | 122 | ClaimWindowActive | 134 | AccountNotWritable |
| 111 | InvalidAccountState | 123 | ClaimWindowElapsed | 135 | InvalidInstructionsSysvar |
| | | | | 136 | AttestorScope |
| | | | | 137 | GovernanceCancelLimit |
| | | | | 138 | ProposalEscalated |
| | | | | 139 | ProposalExpired |

New in the review-1/2 revision: 135 the account passed as the Instructions sysvar is not it; 136 an attestor-co-signed
instruction is not top level or not the only shop-vault instruction of its tx; 137 governance has used its 2 cancels at
this place; 138 the guardian tried to veto an escalated proposal; 139 a governance proposal's 30-day accept window has
passed.

---

## 7. Events (`sol_log_data`; segment 0 = ASCII name, then raw fields)

| name | fields |
|---|---|
| `ConfigInitialized` | attestor, governance, guardian, claim_window_secs, build marker (`shop-vault-build:mainnet` / `:devnet`), rotation_delay_secs |
| `Registered` | place_hash, mint, launcher, vault, vault_state |
| `ClaimRequested` | place_hash, new_owner, nonce u64, unlock_ts i64 |
| `ClaimCancelled` | place_hash, by (pubkey), role u8 (0 guardian, 1 governance, 2 claimant, 3 owner during probation), nonce |
| `ClaimFinalized` | place_hash, owner |
| `Withdrawn` | place_hash, owner, amount u64, total_withdrawn u64 |
| `Unwrapped` | place_hash, amount u64 |
| `AdminChanged` | kind u8, then: 0 paused `[paused, by]` · 1 attestor proposed / 6 guardian proposed `[new, eta, escalated u8]` · 2 attestor applied / 7 guardian applied `[new, probation_until, consented u8]` · 3 attestor / 8 guardian proposal cancelled `[cancelled key, role (0 guardian veto, 1 governance withdrawal)]` · 4 governance proposed `[new, eta, role]` · 5 governance applied `[new, cleared attestor proposal, cleared guardian proposal, was_recovery u8]` · 9 governance proposal withdrawn `[key, role]` |

pump's launch logs are long and can be truncated at the 10 KB log limit. **Account state is authoritative.** Indexers
should treat events as hints and read `VaultState` (one `getMultipleAccounts` per 100 shops).

---

## 8. Transactions and integration (for the web/Worker workflow)

### 8.1 Launch tx (one v0 tx, one CORNERSHOP ALT per cluster)

```text
0  ComputeBudget::SetComputeUnitLimit(~350_000)
1  ComputeBudget::SetComputeUnitPrice(...)
2  pump::create_v2(name, symbol, uri, creator = vault, is_mayhem_mode = false, cashback = false, creator_fee_bps = 0/None, holder_reward = false)
       accounts: mint (S), user = launcher (S, payer), ...
3  shop_vault::register_launch(place_hash)          (attestor S; 9th account = Instructions sysvar; the ONLY shop-vault ix)
4  ATA::CreateIdempotent(launcher, mint, Token-2022) (only with a dev buy)
5  pump::buy_exact_quote_in_v3(user = launcher, ...) (optional dev buy; AFTER 3, since check 8 requires an untraded curve)
signers: launcher (fee payer), mint, attestor   ->  3 signatures
```

Measured sizes (offline, 2026-10-08, with the pump-sdk 3.2.0 builders and web3.js 1.99; scratch script, not committed; LCH-01 re-asserts it, and after the review-1 revision — Instructions sysvar added to `register_launch` and to the ALT — still measures **1,126 B / 1,169 B**; the TS policy test asserts ≤ 1,232 B too). The ALT holds only keys that are identical across launches, with a fixed buyback-fee recipient:

| variant | typical (name 15, sym 4, uri 80) | name 32, sym 10, uri 100 |
|---|---:|---:|
| **co-signed attestor (this spec), with dev buy** | **1,126 B** | **1,169 B** |
| co-signed, no dev buy | 908 B | 951 B |
| ed25519 precompile (153-B msg), with dev buy | 1,298 B ✗ | 1,341 B ✗ |
| ed25519, 112-B msg, with dev buy | 1,257 B ✗ | 1,300 B ✗ |
| ed25519, no dev buy | 1,080 B | 1,123 B |

The Worker must cap `uri` at 100 chars (our own metadata URLs are about 70) and `name`/`symbol` at 32/10. The ALT holds pump
Global, mint_authority, event authorities, global_params/sol_vault (mayhem), FeeConfig, Token-2022, SPL Token, ATA program
(as an account), the WSOL mint, the buyback/fee recipients, the System Program, shop_vault Config, the pump program (as an
account) and the **Instructions sysvar**. Create it and **freeze** it once per cluster. (Without the sysvar in the ALT the
launch tx grows by 32 B: 1,201 B at max metadata, still under 1,232 B.) Program ids invoked at top level stay static, because v0 messages cannot
load them from an ALT.

### 8.2 Claim tx
`[ComputeBudget?] request_claim(nonce = state.claim_nonce + 1)` with accounts `[attestor, new_owner, config, vault_state,
Instructions sysvar]`; no other shop-vault instruction may be in the tx. The signers are the fee payer (new_owner or a relayer), new_owner and attestor.
After the window, anyone sends `finalize_claim`. The Worker cron does this.

### 8.3 "Collect and withdraw" tx (owner, one click; every step except the last is permissionless)
`[pump::sweep_creator_fee (if curve bucket > 0)] [pump_amm::transfer_creator_fees_to_pump (if graduated)]
[pump::collect_creator_fee(creator = vault)] [shop_vault::unwrap_wsol (if a vault WSOL account exists)] [shop_vault::withdraw]`.
The crank runs the same steps without `withdraw` every few hours. That keeps "fees waiting" visible on-chain and gets balances out of
pump's reach in case of a takeover (§10, T13).

### 8.4 Attestor signing policy (normative for the Worker; security depends on it)

The attestor key is a plain ed25519 keypair (Worker secret `ATTESTOR_SECRET`, signing with WebCrypto `Ed25519`). It is
**different per cluster**, which makes cross-cluster replay impossible. It never holds SOL, is never a fee payer, and is never writable.
The Worker signs a transaction message **only if** every rule below holds. Otherwise it returns 4xx and signs nothing.
Since the review-1 revision the policy is defence in depth rather than load-bearing for admin powers: on-chain the attestor
can only authorize `register_launch` / `request_claim`, each alone in its tx (I9). It still decides *which* launch or
claim is approved, so the rules below remain normative. The Worker must sign exactly `message.serialize()` of the
message object it validated, never bytes it did not decode itself. The guardian and governance keys are never in the
Worker.

Launch (`POST /api/launch/attest {reservationId, messageBase64}`):
1. The message is v0, `numRequiredSignatures == 3`, the signers are exactly {reservation.launcher (index 0, fee payer), reservation.mint, attestor}, and the attestor is a read-only signer.
2. It uses no ALT other than the official CORNERSHOP ALT for this cluster.
3. The instructions are exactly the §8.1 sequence (the compute-budget ixs are optional, with CU ≤ 600k and price ≤ cap). There are **no other instructions** and no other program ids.
4. `create_v2` args: name/symbol/uri equal the moderated reservation values; `creator == vault PDA(place_hash)`; mayhem, cashback and holder-reward are false.
5. `register_launch.place_hash == sha256(reservation.placeId)`, and its 9 accounts equal the derived ones (the 9th is the Instructions sysvar).
6. Dev buy: `user == launcher`, `mint == reservation.mint`, spend ≤ the cap.
7. The attestor key's account index is referenced by **exactly one** instruction (`register_launch`, account #1).

Claim (`POST /api/claim/attest`): the session is Twilio-verified for (placeId, new_owner). The message holds only an optional
ComputeBudget ix plus **one** `request_claim` whose accounts are `[attestor, new_owner, config, vault_state(place), Instructions sysvar]` and whose
`nonce == on-chain claim_nonce + 1`. The fee payer is new_owner or our relayer. The attestor is referenced only by that ix.

The order of signatures does not matter. The browser can get the attestor signature, add the mint signature, and then call wallet
`signTransaction`. Any change after the Worker has signed invalidates its signature. Prefer `signTransaction` and sending through
`/api/rpc` over `signAndSendTransaction`, because wallets may try to append guard instructions.

### 8.5 Off-chain mirrors
D1 `coins.place_hash` = hex of `place_hash` above. `fees_waiting` = `vault.lamports − rent_min(0)` + `creator_vault(vault).lamports − rent` +
`curve.creator_fee` + AMM WSOL creator vault + any vault WSOL account. Alert when `curve.creator ≠ vault` on a registered coin, because
that means a pump `admin_cto` happened.

### 8.6 Monitoring (normative for ops)
- Alert on **every** `AdminChanged` event. Ops pre-register each planned proposal (key + kind) in D1; an unregistered
  attestor or guardian proposal (kinds 1, 6) must be **vetoed by the guardian within 7 days**, and an unregistered
  guardian recovery (kind 4, role 0) must be withdrawn by governance within 30 days. A watchdog may hold the guardian key
  to veto automatically, but it must not be the request-path Worker that holds the attestor key.
- Alert on every `ClaimRequested` without a D1 claim row, and on every `Registered` without a D1 coin row.
- While `probation_until > now`, show a banner on affected shop pages and notify verified owners: a claim requested now
  can be cancelled by the owner, and owners should withdraw.

---

## 9. Implementation notes

- Crate: `programs/shop-vault` (`cdylib` + `lib`). Use `#![no_std]`, `program_entrypoint!` + `no_allocator!` + `nostd_panic_handler!`, and avoid `msg!` with formatting. Dependencies pinned **exactly**: `pinocchio = "=0.11.2"` (try `default-features = false, features = ["cpi"]` and add back `copy` if needed; it must not need `alloc`) and `pinocchio-system = "=0.6.1"` (CreateAccount/Transfer/Allocate/Assign). There is no token crate: the Token CloseAccount CPI is hand-encoded. Check API names (`AccountView`, `Address`, `find_program_address`, `Rent`/`Clock::get`) against the 0.11.2 docs.
- Files: `lib.rs` (entrypoint and dispatch on byte 0), `consts.rs`, `error.rs`, `state.rs` (offset accessors plus `const` asserts on the lengths), `pda.rs`, `events.rs`, `ix/{init,register,claim,withdraw,unwrap,admin}.rs`.
- `[profile.release]`: `lto = "fat"`, `codegen-units = 1`, `overflow-checks = true`. Try `opt-level = "z"` versus `3` and keep whichever is smaller once both pass the CU budgets. All lamport and time arithmetic uses `checked_*`.
- `declare_id!` uses the `.keys/shop-vault-program.json` pubkey. Build with `scripts/build.sh`: `cargo build-sbf --features devnet --sbf-out-dir target/deploy-devnet` then `cargo build-sbf --sbf-out-dir target/deploy`, each followed by `scripts/check-artifact.sh <so> <flavour>` (size gate + flavour marker). **Never run a bare `cargo build-sbf --features devnet`**: it writes `target/deploy/shop_vault.so`. `check-artifact.sh target/deploy/shop_vault.so mainnet --verified` (solana-verify + Docker) is the pre-deploy gate (§11).
- Size gate: `stat -f%z target/deploy/shop_vault.so` must be **< 40,960**. Measured after the review revision: **35,928 B** (both builds); the admin instructions share one dispatcher and one rotation code path to stay there. At mainnet rent of 5,080 lamports/B, 40 KB ≈ 0.21 SOL locked, with a peak of about 0.42 SOL during deploy (the buffer is refunded). Deploy with `--max-len` equal to the binary size and use `solana program extend` before a larger upgrade.
- CU targets, asserted in tests and tuned after the first measurement: `register_launch` ≤ 25k (3 `find_program_address` calls plus 1-2 CPIs; measured 12.7k-17.2k including the sysvar scan), `withdraw` ≤ 8k, `unwrap_wsol` ≤ 10k, `request_claim`/`cancel`/`finalize`/admin ≤ 4k (request_claim 1.6k), `initialize_config` ≤ 25k (10.7k).

---

## 10. Threat model

| # | Threat | Mitigation | Tests |
|---|---|---|---|
| T1 | **Attestation replay or cross-place reuse** | The attestor signs a whole tx, so the signature is bound to its blockhash (≈60-90 s) and to the exact accounts and data. The runtime rejects duplicate signatures. Claims also need `nonce == last + 1`, which is consumed even if the claim is cancelled. The place is bound through the `vault_state` key in the signed message and through PDA derivation from `place_hash`. Each cluster has its own attestor key. | LCH-03, CLM-03, CLM-10, CLM-12 |
| T2 | **Fake Config, VaultState or Vault** | Config and VaultState must be program-owned with the right tag and length; they are only ever created at canonical PDAs. The vault address is re-derived from the stored bump, and the vault must be system-owned with no data. | LCH-10, LCH-16, WDR-05, CLM-10 |
| T3 | **Fake bonding curve or wrong creator** | The curve must be pump-owned, at the canonical PDA of `mint`, with the right discriminator and `creator == vault`. Unsupported curve flags are rejected and the curve must be untraded. | LCH-05..09 |
| T4 | **PDA/bump canonicalisation** | `find_program_address` at creation, bumps stored, never accepted from instruction data. Pump's curve PDA is re-derived as well. | LCH-10 |
| T5 | **Signer, owner and writable gaps** | Explicit checks are listed per instruction in §5. Fake system and token programs are rejected by key. | LCH-13/14, WDR-04/08, WRP-02 |
| T6 | **Rent-exemption** | The vault never drops below `rent_min(0)`, read from the sysvar, so it is topped up at register and preserved on withdraw. VaultState never drops below its rent minimum. Neither account is ever closed. | WDR-01, LCH-11/12 |
| T7 | **Lamport and time overflow** | `checked_*` everywhere and `overflow-checks = true`. | WDR-09, INV-01 |
| T8 | **Front-running or squatting a place** | Registering needs the attestor, and the Worker reserves one launch per place for 2 minutes. A copied tx is the same tx. Coins created *outside* our UI with `creator = vault` cannot be registered (no attestor), but they still pay the shop, so they cause no harm. A pump-level pre-fund of the mint address only makes that launch fail, and the client retries with a new mint. | LCH-02/03 |
| T9 | **Griefing** | Pre-funded VaultState or Config PDAs are adopted (§5.1). A pre-funded vault is fine. Claim spam needs the attestor. `finalize` is deterministic. Config is read-only on hot paths, so there is no write-lock contention. Stray SOL on VaultState can be withdrawn. WSOL pushed into a vault token account can be unwrapped (D7). Other SPL tokens sent to a vault cannot be recovered (out of scope, documented). | LCH-11/12, WRP-*, INV-01 |
| T10 | **Attestor key compromise or loss** (online key, the most likely compromise) | The attestor has **no admin power** (I9): it cannot cancel, pause, veto, or apply rotations, and each co-signature authorizes one launch or one claim only. The attacker can register unlaunched places with arbitrary names (permanent, but the coin still pays the shop and the UI can hide it) and open claims (public window, ≥ 72 h, during which the owner can still withdraw). **Detection:** alert on every `ClaimRequested`/`Registered` that has no D1 row. **Response:** guardian pauses and cancels every rogue pending claim before `unlock_ts` (no limit); governance proposes a new attestor and the guardian consents (immediate; the old attestor cannot interfere). Worst case: a rogue claim nobody cancels within its window. Survived without loss or permanent freeze. | ADM-03/04, CLM-07, CLM-15, LCH-18, r1_hostile_attestor_* |
| T10b | **Attestor co-signature scope** | Was: the attestor's signature on a launch tx also authorized `cancel_claim`/`set_paused`/rotation instructions in the same tx (review 1). Now the attestor has no such powers and `register_launch`/`request_claim` refuse any tx with another top-level shop-vault instruction or a CPI caller (`AttestorScope`). A policy slip in the Worker can at worst approve the one launch or claim it was asked to sign. | LCH-18, CLM-15, r1_cosigned_launch_* |
| T10c | **Guardian key compromise or loss** | A hostile guardian can pause launches (governance unpauses), cancel claims (no limit), veto each attestor/guardian proposal **once** (the next is escalated: 14 d, not vetoable), and propose a governance recovery (governance must withdraw it within 30 d; §8.6 alert). It cannot move funds, approve claims or launches, or install keys. **Response:** governance replaces it: ≤ 7 d, or ≤ 7 + 14 d if it vetoes. Freeze is bounded by that. Lost guardian: replaced after 7 d. Survived. | ADM-05, ADM-10, r1_hostile_guardian_veto_is_bounded |
| T11 | **Governance compromise** (root of trust; corrected after review 2: governance **is fund-critical**) | Governance alone cannot move funds directly, cannot cancel more than 2 claims per place, and its rotation proposals take 7 d (+14 d escalated after each guardian veto, at most one per kind). Every attestor change starts a 7-day probation in which new claims cannot finalize before probation end + window and owners may cancel them. While the honest guardian is in office it cancels every rogue claim (no limit), so a rogue attestor alone steals nothing (r2_a1). **Residual:** governance can replace the guardian (7 d unwatched; ≥ 14 d after a guardian veto, since the escalated proposal cannot be vetoed), then have its guardian consent to a rogue attestor: unclaimed shops can then be claimed after ≥ 7 d + 7 d + 72 h (≥ 14 d + 7 d + 72 h with a guardian veto), owned shops once the probation is over; everything happens in public events. Owners keep full withdrawal rights until a rogue claim finalizes, so the loss is limited to unclaimed balances and future fees. Governance must therefore be a 2-of-3 (or stronger) Squads multisig on hardware keys, separate from the guardian and the attestor, and the guardian must watch (§8.6). Governance **loss**: guardian recovery after 30 d. | r2_a1, r2_a1b, r2_a1c, ADM-07*, CLM-07b, CLM-14 |
| T11b | **Governance behind a time lock** | A cancel executing at/after `unlock_ts` is refused by design (cancel and finalize split time cleanly). The guardian has no time lock and is the primary canceller; governance's Squads `time_lock` must stay **< claim_window_secs − 24 h** (§11), and the upgrade-authority multisig (which may have a long time lock) must be a different multisig from governance. | r2_a2 |
| T12 | **Upgrade authority** | It can replace the code (the only path to an admin drain). Deploy key → Squads vault with a timelock right after init → publish the verifiable-build hash → `--final` after ≥30 days without incidents plus an external review. | runbook |
| T13 | **pump.fun admin powers (out of our control)** | `admin_cto` (Squads `UqN2p5…`) can redirect **future** creator fees of any coin, including ours. A system-owned vault gets its accrued balance paid on a takeover if it is passed as writable, otherwise the balance stays collectable. `set_creator` (set-creator authority) and pump program upgrades (`7gZuf…`) can change behaviour and fee tiers at will. Mitigations: crank collects often; UI disclosure; ask pump BD to exempt CORNERSHOP PDAs; indexer alert when `curve.creator ≠ vault`. Non-issues for us: `set_metaplex_creator` (no Metaplex metadata can exist for a create_v2 Token-2022 mint), fee sharing (needs our vault's signature), `migrate_*_creator` (needs a sharing config). | FEE-04/05/06 |
| T14 | **pump ABI drift** | Only `register_launch` reads pump (the stable curve prefix). Funds paths are independent (D4). Drift means launches fail safely until an upgrade or a v2 program. The devnet E2E is re-run on every pump SDK bump. | devnet E2E |
| T15 | **Clock skew** | `unix_timestamp` is stake-weighted and drift-bounded. A 72 h window absorbs it. | — |
| T16 | **Account aliasing** | Signers cannot be PDAs, and vault, state and curve have distinct owners or seeds. In `unwrap_wsol`, the vault as both destination and authority is intended and safe. | — |
| T17 | **Legal/custody** | Out of scope of this spec. | — |
| T18 | **Devnet binary deployed to mainnet** | Mainnet and devnet share the program id. The devnet build refuses the mainnet window (max 24 h < 72 h), so `initialize_config(.., 259200)` fails on it; any Config it creates has `flavor = 1` and `rotation_delay_secs = 300`, and `ConfigInitialized` carries `shop-vault-build:devnet`. `scripts/build.sh` builds devnet into `target/deploy-devnet/`, and `scripts/check-artifact.sh .. mainnet --verified` (flavour marker, size, solana-verify hash) gates the deploy. | INIT-05b, BLD-01, r2_a3 |

**There is no admin withdrawal.** No instruction can send vault or state lamports anywhere except `VaultState.owner` (I1, I2, I8).

**Which single-key compromise does the system survive?** Attestor: yes (no loss, no lasting freeze). Guardian: yes
(bounded launch/claim freeze, ≤ 21 days). Governance: no instant loss and no freeze by cancels, but it is the root of
trust and can eventually take over through the slow, public path in T11; it must be protected accordingly. Any two of
governance + guardian: total. Upgrade authority (before `--final`): total (T12).

---

## 11. Keys, governance and lifecycle

Keys in `.keys/` at the repo root (gitignored, never printed or committed):
`shop-vault-program.json`, `deployer-devnet.json`, `attestor-devnet.json`, `guardian-devnet.json`, `governance-devnet.json`,
`crank-devnet.json`, `e2e-{launcher,trader,owner,owner2}.json`, and later `attestor-mainnet.json` (copied into the Worker
secret, then kept offline). The mainnet deployer is the user's wallet.

Three roles, three different custodians (D9):

| key | where | powers | must never |
|---|---|---|---|
| attestor | Worker secret (request path) | co-sign one launch / one claim per tx | be the guardian, governance, a fee payer, or funded |
| guardian | a hardware wallet held by ops, or a separate watchdog service (§8.6) | pause, cancel claims, veto once / consent to rotations, propose governance recovery | live in the request-path Worker; be a multisig with a time lock |
| governance | Squads vault **A**: 2-of-3 hardware keys, `time_lock` **< claim_window_secs − 24 h** (mainnet: ≤ 48 h; recommended 0-12 h) | propose rotations and handovers, pause, ≤ 2 cancels per place | be the upgrade authority's multisig if that one has a long time lock |
| upgrade authority | Squads vault **B** (may be time-locked, e.g. 7 d) until `--final` | replace the code | be governance vault A when B's time lock ≥ the claim window |

Invariant to check at every change: `claim_window_secs > governance time_lock + 24 h reaction margin`. Otherwise a
governance cancel can only execute after `unlock_ts` and is refused (T11b). The guardian has no time lock, so it remains
the primary canceller either way.

Mainnet order (the order matters because `initialize_config` needs the upgrade-authority signature):
0. **Artifact gate:** `scripts/build.sh`, then `scripts/check-artifact.sh target/deploy/shop_vault.so mainnet --verified`
   (size < 40,960 B, `shop-vault-build:mainnet` marker and no devnet marker, executable hash equal to a fresh
   `solana-verify build`). Deploy only that file. Never deploy anything from `target/deploy-devnet/`.
1. `solana program deploy --max-len <size>` with the user's deployer.
2. `initialize_config(attestor_mainnet, governance = deployer, guardian_mainnet, 259200)`. Check the `ConfigInitialized`
   event and Config: `flavor == 0`, `rotation_delay_secs == 604800`. (A devnet binary refuses 259200.)
3. `propose_governance(squads_vault_A)`, then vault A executes `accept_governance` within 30 days.
4. Move the upgrade authority to Squads vault B (time-locked).
5. Create and freeze the ALT (including the Instructions sysvar).
6. Run a smoke launch on a test place. Enable the §8.6 alerts and the guardian watchdog.
7. After ≥30 days, review, then `set-upgrade-authority --final` through vault B.

Devnet uses the same steps with local keys, the devnet build from `target/deploy-devnet/` (`check-artifact.sh … devnet`)
and a 60 s window.

---

## 12. Out of scope for v1 (candidates for v1.1)

- `transfer_ownership` (owner-signed wallet rotation without a phone re-claim)
- Pre-claims before a coin exists
- Recovering non-WSOL tokens sent to a vault
- A setter for the claim window
- Multiple attestors
- Delisting or retiring a registration (would break "one coin per place")

---

## 13. Test plan

### 13.1 Harness
- **LiteSVM in TypeScript**: `litesvm@1.5.0` (Kit 8 based), plus `@pump-fun/pump-sdk@3.2.0`, `@pump-fun/pump-swap-sdk@2.1.0`, `@solana/web3.js@1.99.0` and `@solana/spl-token`, all pinned exactly, run with `node --test` and `tsx`. pump instructions come from the **same SDK builders the app uses**. A small adapter serialises a web3.js `VersionedTransaction` and decodes it with Kit's `getTransactionDecoder()` before `svm.sendTransaction`.
  Fallback if the adapter fights back: Rust `litesvm = "0.17"` with IDL-encoded pump instructions. `mollusk-svm 0.16` is optional, for per-instruction CU profiling.
- Rust unit tests: layout offsets and lengths (`const` asserts), the `create_or_adopt` branches, and overflow helpers.
- Both builds are tested. The mainnet build gets clock warps of ≥ 72 h; the devnet build gets a 60 s window.

### 13.2 Fixtures (`scripts/dump-fixtures.sh`, read-only RPC; output gitignored, `tests/fixtures/manifest.json` with slot + sha256 committed)
```bash
solana program dump -u m 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P tests/fixtures/pump.so
solana program dump -u m pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ tests/fixtures/pump_fees.so
solana program dump -u m MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e tests/fixtures/mayhem.so
solana program dump -u m pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA tests/fixtures/pump_amm.so   # P2 tests
# accounts: tests/fixtures/accounts.ts builds create_v2 / buy_v2 / buy_exact_quote_in_v3 / sweep / collect with the SDK
# for two random mint+user pairs, keeps keys common to both (Global, FeeConfig, mayhem global_params/sol_vault,
# fee + buyback recipients, volume accumulators, ...), then for each:
solana account -u m <KEY> --output json --output-file tests/fixtures/accounts/<KEY>.json
```
Setup per test: load the four programs plus `target/deploy/shop_vault.so`. Fabricate the shop_vault **ProgramData**
account bytes (`[3,0,0,0] slot:u64 1 authority:32`, owner = the upgradeable loader) at its PDA; the program only reads it. Set Clock
to the fixture slot's time and use the default Rent; expectations read the same sysvar. LiteSVM does not enforce the 1,232 B packet
limit, so **assert the serialised size** in LCH-01. Create a real ALT in the test for that assertion.

### 13.3 Cases (every instruction and every error path). Each failing case also asserts that **no state changed**.

**Init**: INIT-01 happy (fields, rent) · INIT-02 signer is not the upgrade authority → `NotUpgradeAuthority` · INIT-03 wrong programdata address, wrong owner, tag ≠ 3, or authority `None` → `NotUpgradeAuthority` · INIT-04 second init → `AlreadyInitialized` · INIT-05 window 59 s / 72 h − 1 / 30 d + 1 (mainnet build) → `InvalidWindow`; INIT-05b devnet build: 59 s, 24 h + 1, **72 h (the mainnet runbook value)** → `InvalidWindow`, Config `flavor = 1`, marker `shop-vault-build:devnet` · INIT-06 zero or equal keys (any pair of attestor / governance / guardian) → `InvalidAuthorityKey` · INIT-07 config pre-funded by an attacker → still succeeds · INIT-08 wrong config address → `InvalidConfig`; no signer → `MissingRequiredSignature`; fake system program → `InvalidSystemProgram`.

**Launch (real pump)**: LCH-01 happy atomic tx [cb, create_v2(creator = vault), register, ATA, buy_exact_quote_in_v3] through the ALT: state fields, `curve.creator == vault`, `vault.lamports == rent_min(0)`, tx ≤ 1,232 B for typical and max metadata, CU recorded · LCH-02 second launch, same place, new mint → `AlreadyRegistered`, and the **second mint account does not exist** (the whole tx reverted) · LCH-03 attestor missing → `MissingRequiredSignature`; signed by a random key in the attestor slot → `AttestorMismatch` · LCH-04 paused → `LaunchesPaused`; unpause → OK · LCH-05 creator = launcher, or the vault of another place → `CreatorMismatch` · LCH-06 register placed before create_v2 → `InvalidBondingCurve` · LCH-07 dev buy before register → `CurveNotFresh` · LCH-08 mayhem create → `UnsupportedCurve`; with Global patched to enable holder rewards, a holder-reward create → `CreatorMismatch` (pump overrides creator with the holder-rewards PDA, so check 6 fires before check 7); a USDC-quoted create (whitelisted quote) → `UnsupportedCurve` · LCH-09 fake curve (copied bytes in a system- or other-owned account) or the real curve of another mint → `InvalidBondingCurve` · LCH-10 non-canonical or random state/vault addresses → `InvalidVaultState`/`InvalidVault` · LCH-11 VaultState PDA pre-funded with 1 lamport and with 1 SOL → OK (adopt path), surplus later withdrawable · LCH-12 vault pre-funded → OK, balance kept · LCH-13 fake system program → `InvalidSystemProgram` · LCH-14 launcher not a signer → fails · LCH-15 bad length or unknown discriminator → `InvalidInstruction`; 7 or 8 accounts → `NotEnoughAccountKeys` · LCH-16 fake config (other owner, same bytes) → `InvalidConfig` · LCH-17 extra trailing accounts ignored · LCH-18 fake Instructions sysvar → `InvalidInstructionsSysvar`; any other shop-vault instruction before or after `register_launch`, or two launches under one attestor signature → `AttestorScope`, whole tx reverted.

**Fees (the D1 proof)**: FEE-01 v3 buys and sells from a trader → bucket > 0 → `sweep_creator_fee` → `collect_creator_fee(creator = vault)` with a stranger as fee payer → vault delta == Σ `TradeEvent.creatorFee`, vault still system-owned with 0 data · FEE-02 the same with `buy_v2`/`sell_v2` (paid straight into creator_vault) · FEE-03 control: creator = a program-owned data account → **record** pass or fail (informational) · FEE-04 `create_fee_sharing_config` for our mint by a stranger → pump 6016 · FEE-05 `set_metaplex_creator` on our coin → creator unchanged · FEE-06 (P2) Global patched so `admin_set_creator_authority` = a test key → `admin_cto` moves future fees, and the vault receives its accrued balance when passed as writable (documents T13).

**Claims**: CLM-01 request (nonce 1) → pending and `unlock = now + window` · CLM-02 attestor missing or wrong, or new_owner not signing → errors · CLM-03 nonce 0, 2, or 1 reused after a cancel → `BadNonce` · CLM-04 request while pending → `ClaimAlreadyPending` · CLM-05 new_owner = owner → `SameOwner`; = attestor, governance or guardian → `InvalidOwner` · CLM-06 finalize at `unlock − 1` → `ClaimWindowActive`; at `unlock` → OK · CLM-07 cancel by guardian, governance or the claimant → cleared; by the attestor, the current owner (no probation) or a stranger → `Unauthorized`; at `unlock` → `ClaimWindowElapsed` · CLM-07b governance's third cancel at a place → `GovernanceCancelLimit`, the guardian and claimants still can, the budget is per place, and the claim then finalizes · CLM-14 probation: after an attestor change a claim unlocks at `probation_until + window`, is flagged, and the owner may cancel it (role 3); after probation, no flag and no owner cancel; the flag survives the end of probation · CLM-15 two claims, or a claim plus another shop-vault instruction, under one attestor signature → `AttestorScope`; fake sysvar → `InvalidInstructionsSysvar` · CLM-08 finalize or cancel with nothing pending → `NoPendingClaim` · CLM-09 re-claim of an owned shop: A withdraws during B's window; after finalize, A → `NotOwner` and B works · CLM-10 claiming place X leaves Y untouched; fake state → `InvalidVaultState` · CLM-11 works while paused · CLM-12 resubmitting the identical signed tx is rejected (signature already processed).

**Withdraw**: WDR-01 pays `vault − rent_min(0)` plus state surplus; vault ends at exactly `rent_min(0)`; `total_withdrawn` updated · WDR-02 new fees → withdraw again → only the delta · WDR-03 nothing → `NothingToWithdraw` · WDR-04 stranger → `NotOwner`; owner not a signer → `MissingRequiredSignature`; no owner yet → `NoOwner` · WDR-05 other place's vault or a random account → `InvalidVault` · WDR-06 atomic [sweep, collect, withdraw] · WDR-07 relayer as fee payer · WDR-08 fake system program · WDR-09 `total_withdrawn` near u64::MAX → `ArithmeticOverflow` · WDR-10 works while paused and with a pending claim.

**Unwrap**: WRP-01 WSOL account owned by the vault (InitializeAccount3 + transfer + SyncNative) → unwrap → vault + all lamports, account closed · WRP-02 non-native mint, wrong owner, wrong token program, frozen account → errors · WRP-03 (P2, pump_amm fixtures or devnet) `collect_coin_creator_fee` into the vault's WSOL ATA → unwrap.

**Admin**: ADM-01 `set_paused` by guardian or governance; the attestor or a stranger → `Unauthorized`; value 2 → `InvalidInstruction` · ADM-02 propose (attestor and guardian) by non-governance → `Unauthorized`; zero key or a key equal to another role → `InvalidAuthorityKey`; overwrite · ADM-03 accept by the guardian immediately (probation starts); by the old attestor, governance or a stranger before eta → `RotationNotReady`, by anyone at eta → OK; nothing pending → `NoPendingRotation` · ADM-04 after rotation, the old attestor fails launch and claim (`AttestorMismatch`) and the new one works; no attestor has any admin power · ADM-05 (both kinds) governance withdraws (no veto flag); guardian vetoes (flag); escalated re-proposal: 14 d, guardian veto → `ProposalEscalated`, applied by anyone at eta, flag cleared · ADM-06 atomic propose+accept in one tx, also for an escalated proposal · ADM-07 governance handover two-step; wrong signer → `Unauthorized`; the handover clears pending attestor/guardian proposals and flags; the old governance loses power · ADM-07b zero key withdraws; `ProposalExpired` after 30 d; re-proposal renews · ADM-07c guardian recovery: 30 d delay, governance withdraws or overwrites it, the guardian withdraws only its own, the recovery key takes over after 30 d · ADM-08 the three keys stay distinct across every rotation order · ADM-09 bad data, fake config · ADM-10 guardian rotation: consent, lost-guardian timeout, old guardian loses every power, no probation.

**Review regressions** (each reviewer's exploit test now asserts the fix): `review_1_governance.rs` (stale proposal cleared by the handover; hostile attestor has no veto/cancel; hostile guardian veto bounded; governance cancel cap + recovery; governance proposal withdraw/expiry) · `review_1_launch_probes.rs::r1_cosigned_launch_*` (no piggy-backed attestor powers) · `review_2_authority_blast_radius.rs` (r2_a1: 60 days of rogue claims after a governance-installed attestor, nothing stolen; r2_a1b: veto escalation; r2_a1c: residual governance takeover path timed at 14 d + 7 d + 72 h; r2_a2: cancel deadline, guardian cancels in time; r2_a3: devnet binary refuses the mainnet window and identifies itself).

**Invariants**: INV-01 a seeded random walk of 2,000 operations over 3 places: fee inflows (direct lamport credits plus real collects), requests, cancels (guardian, governance with its cap, attestor, claimant, owner in probation, stranger) and finalizes with random signers and clock warps (including probation ends), withdraws by random signers, unwraps, pauses by all three roles, and attestor rotations with probation. After every step assert I1-I6, I11 and the conservation rule `Σ withdrawn + Σ (vault − rent_min(0)) + Σ (state − rent_min(STATE)) == Σ inflow`.

**Build**: BLD-01 `.so` < 40,960 B for both features, each with only its own flavour marker, and no devnet artifact in `target/deploy/` · BLD-02 CU ≤ the §9 targets · BLD-03 `cargo clippy -D warnings` and `cargo build-sbf` reproducible (`solana-verify build` hash recorded).

### 13.4 Order of work
1. Fixtures plus FEE-01/02/03, using a throwaway `register` stub if needed, to **prove D1 first**.
2. The program itself.
3. LCH, CLM, WDR, WRP, ADM, INIT.
4. INV.
5. Devnet E2E.

### 13.5 Devnet end-to-end (`scripts/devnet-e2e.ts`, `DRY_RUN=true` by default)
Implemented in `scripts/devnet-deploy.sh` + `scripts/devnet-e2e.ts`; status, addresses, costs and how to run are in
`DEVNET.md`. Automated so far: steps 1-5 and 8. Step 7 runs only the curve buy-out and the wait for migration
(`GRADUATE=1`). Not yet automated: step 6 (rotation demo) and step 7's PumpSwap / `unwrap_wsol` leg. The keys are
`.keys/devnet-<role>.json`.
**Guards:** abort unless `getGenesisHash() == EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. Keys come only from `.keys/` and are never logged. Every tx is simulated before it is sent. A JSON report (signatures, balances) goes to `scripts/out/` (gitignored).
1. `scripts/build.sh`; deploy `target/deploy-devnet/shop_vault.so` with `--max-len` (`check-artifact.sh … devnet` passes). Run `initialize_config(attestor-devnet, governance-devnet, guardian-devnet, 60)`. Create and freeze the ALT.
2. Launch the fictional place `cornershop-test:cafe-1` (not a real Google id) atomically with a 0.01 SOL dev buy. Assert the VaultState and `curve.creator == vault`, and record the size and CU.
3. Launch the same place again with a new mint → `AlreadyRegistered`, and the mint does not exist.
4. The trader buys and sells (v3 and v2) → sweep + collect → vault delta == Σ creatorFee from the decoded `TradeEvent`s.
5. `request_claim(owner)` → withdraw → `NoOwner`; finalize early → `ClaimWindowActive`; wait 61 s → finalize → withdraw pays exactly `vault − rent_min(0)`.
6. `request_claim(owner2, nonce 2)` → owner2 cancels → `request_claim` with nonce 2 → `BadNonce`. Then rotate the attestor (governance propose + guardian accept) and show the old key is refused and the next claim is in probation (unlock = probation end + 60 s).
7. Graduation: buy about 2.9 SOL to complete the curve. Poll up to 30 min for pump's migration bot to create the pool. Trade on PumpSwap (`@pump-fun/pump-swap-sdk`). Run `transfer_creator_fees_to_pump` + collect → vault grows → withdraw. Then run `collect_coin_creator_fee` into a vault WSOL ATA → `unwrap_wsol` → withdraw.
8. Pause → launch refused; claims and withdraws still work → unpause.

Budget: about 5 devnet SOL (deploy about 0.3, graduation about 3, fees). Re-run steps 2-5 on every pump SDK or IDL bump.

---

## Appendix A: rejected alternatives

**A1. Ed25519 precompile attestation (the original brief).** This is valid but makes the atomic launch tx 1,298 B (§8.1).
If v1 transactions (4 KB, SIMD-0296/0385) become wallet-supported, or if the dev buy moves to a second tx or a Jito bundle,
use these exact rules:
- The ed25519 ix is at `current_index − 1` and its program id is `Ed25519SigVerify111111111111111111111111111`.
- The Instructions sysvar account key is `Sysvar1nstructions1111111111111111111111111`. Check this, or a fake sysvar can be passed in.
- `data[0] == 1` and `data[1] == 0`.
- `signature_instruction_index == public_key_instruction_index == message_instruction_index == 0xFFFF` (the ix itself).
- `public_key_offset == 16`, `signature_offset == 48`, `message_data_offset == 112`, `message_data_size == MSG_LEN`, and `data.len() == 112 + MSG_LEN`.
- `data[16..48] == config.attestor`.
- Messages (fixed-size, LE):
  - Launch: `"CORNERSHOP:LNCH1"(16) ‖ program_id ‖ cluster u8 ‖ place_hash ‖ launcher ‖ mint ‖ expiry i64` (153 B).
  - Claim: `"CORNERSHOP:CLAM1"(16) ‖ program_id ‖ cluster u8 ‖ place_hash ‖ new_owner ‖ nonce u64 ‖ expiry i64` (129 B).
- Require `now ≤ expiry ≤ now + 3600`.
- Weakness: a launch attestation does not bind name/symbol/uri unless the program parses `create_v2` args (brittle). The launcher could bypass moderation.

**A2. CPI into `create_v2`.** Rejected (D3). It ties us to the 16-account ABI, deepens CPI nesting (ours → pump → ATA → Token-2022/System), makes the ix and binary bigger, and adds no security, because the creator is just an argument and the vault does not need to sign.

**A3. Instructions-sysvar scan for `create_v2` in the same tx.** Rejected (D3). It is redundant with the attestor co-sign plus `real_quote_reserves == 0`, and it breaks if pump renames or reorders `create_v2`.

**A4. Program-owned data account as the pump creator.** Rejected (D1). It was never verified, and `admin_cto` treats such creators differently. FEE-03 records whether it would have worked.

**A5. Owner veto on re-claims.** Rejected (D6), except for claims requested during a probation (D11), which is
bounded in time. A permanent owner veto would let a stolen owner key block phone-verified recovery forever.

**A6. Keeping admin powers on the attestor and only filtering in the Worker.** Rejected after review 1: the online key
is the most exposed one, and every relaxation of the Worker policy would have turned a co-signed launch into an admin
action. The attestor now has no admin power (D9) and its co-signature is bound to one instruction on-chain (D2).

**A7. Joint guardian+governance cancels / a shared cancel budget.** Rejected: with a shared budget a hostile governance
could spend it on its own rogue claims and leave the honest guardian unable to cancel. Only governance is capped; the
guardian is replaceable by governance, so it is not.
