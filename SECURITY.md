# Security policy

AtlasPad runs a live Solana mainnet program that holds creator fees in per-shop vaults. Please report vulnerabilities
privately.

## How to report

- Preferred: GitHub → Security → "Report a vulnerability" (a private advisory).
- Or email hello@atlaspad.online with "SECURITY" in the subject.
- Do not open public issues or pull requests, or post publicly, about security bugs.
- Test on devnet or locally (the LiteSVM tests in `programs/shop-vault/tests`), never against mainnet funds you do
  not own.

## Scope

- The on-chain program `programs/shop-vault`: mainnet program id `6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x`
  (`programId` in `deploy/mainnet.json`).
- The Cloudflare Worker (`worker/`) and https://atlaspad.online/api/*.
- The front end (`src/`) at https://atlaspad.online.

Out of scope: pump.fun/PumpSwap, Google, Cloudflare and wallet software; volumetric denial of service; issues that need
a compromised operator key.

## What to expect

- Acknowledgement within 72 hours, and a status update within 7 days.
- Every claim waits through a public 72-hour window before it takes effect. During it the guardian can cancel a pending
  claim, and it can pause new launches at any time (trading, claims and withdrawals keep working), so early reports
  help.
- Credit in the advisory if you want it. There is no paid bounty at present.

## Who can do what on chain

The full model is in `programs/shop-vault/SPEC.md` (D6, D9, §10 threats, §11 keys). In short:

- No admin instruction can move vault funds. Only the shop's verified owner can withdraw, and only to the owner wallet.
- The **attestor** (the Worker's key) co-signs one launch or one claim per transaction and has no other power.
- The **guardian** can pause launches, cancel pending claims and veto a key rotation once.
- **Governance** proposes rotations and handovers, can pause, and can cancel at most 2 claims per shop. It is a single
  key today, being handed over to a 2-of-3 Squads multisig (`squadsAVault` in `deploy/mainnet.json`).
- The **upgrade authority** is a 2-of-3 Squads multisig with a 7-day time lock (`upgradeAuthority`). An upgrade could
  change how vaults pay out; upgrades are public on Solana.

## Audit status

shop-vault has not had an independent external audit. It has had internal adversarial reviews, and its LiteSVM tests
run against the real pump.fun program binaries dumped from mainnet. The deployed binary is reproducible with
solana-verify (`.github/workflows/verifiable-build.yml`; the README shows how to check it): its sha256 is
`programDataSha256` in `deploy/mainnet.json`.
