//! WRP-*: `unwrap_wsol` closes a vault-owned WSOL account into the vault; permissionless (SPEC §5.7, D7).
#![allow(clippy::result_large_err, deprecated)]
mod common;

use common::*;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;

const PLACE: &str = "ChIJN1t_tDeuEmsRUsoyG83frY4";

fn sync_native(account: Address) -> Instruction {
    Instruction { program_id: SPL_TOKEN, accounts: vec![AccountMeta::new(account, false)], data: vec![17] }
}

/// Creates the WSOL ATA of `owner` and wraps `lamports` into it (anyone can do this to a vault).
fn wrap_into(env: &mut Env, owner: &Address, lamports: u64) -> Address {
    let payer = env.funded(lamports / LAMPORTS_PER_SOL + 2);
    let a = wsol_ata(owner);
    ok(env.send(
        &[
            create_ata_idempotent(payer.pubkey(), *owner, NATIVE_MINT, SPL_TOKEN),
            system_transfer(payer.pubkey(), a, lamports),
            sync_native(a),
        ],
        &payer,
        &[],
    ));
    a
}

#[test]
fn wrp01_unwrap_moves_everything_into_the_vault() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let ata = wrap_into(&mut env, &l.vault, 2 * LAMPORTS_PER_SOL);
    let ata_lamports = env.lamports(&ata);
    assert_eq!(ata_lamports, 2 * LAMPORTS_PER_SOL + env.rent(165));
    let vault0 = env.lamports(&l.vault);
    // A stranger runs it; no owner exists yet.
    let stranger = env.funded(1);
    let m = ok(env.send(&[sv::unwrap_wsol(&l.ph, ata)], &stranger, &[]));
    assert!(env.account(&ata).is_none(), "WSOL account closed");
    assert_eq!(env.lamports(&l.vault) - vault0, ata_lamports, "rent + wrapped SOL land in the vault");
    let va = env.account(&l.vault).unwrap();
    assert_eq!((va.owner, va.data.len()), (sv::SYSTEM, 0));
    let ev = program_events(&m, "Unwrapped");
    assert_eq!(ev[0][2], ata_lamports.to_le_bytes().to_vec());
    let cu = shop_vault_cu(&m)[0];
    println!("unwrap_wsol CU {cu}");
    assert!(cu <= 10_000, "unwrap CU {cu}");
    // The owner then withdraws it.
    let owner = env.claim_and_finalize(&l.ph);
    let before = env.lamports(&owner.pubkey());
    ok(env.send(&[sv::withdraw(owner.pubkey(), &l.ph)], &owner, &[]));
    assert_eq!(env.lamports(&owner.pubkey()) + 5_000 - before, ata_lamports);
}

#[test]
fn wrp02_rejects_wrong_accounts() {
    let mut env = Env::initialized();
    let l = env.launch(PLACE, 0);
    let other = env.launch("other-place", 0);
    let stranger = env.funded(5);
    let good = wrap_into(&mut env, &l.vault, LAMPORTS_PER_SOL);

    let check = |env: &mut Env, ix: Instruction, code: u32| {
        let keys = [good, l.vault, l.state];
        let before = env.snapshot(&keys);
        let r = env.send(&[ix], &stranger, &[]);
        expect_custom(&r, code);
        assert_eq!(env.snapshot(&keys), before);
    };

    // Non-native mint (a USDC account owned by the vault).
    ok(env.send(&[create_ata_idempotent(stranger.pubkey(), l.vault, USDC, SPL_TOKEN)], &stranger, &[]));
    check(&mut env, sv::unwrap_wsol(&l.ph, ata(&l.vault, &USDC, &SPL_TOKEN)), e::INVALID_TOKEN_ACCOUNT);
    // WSOL account of another owner (the other place's vault, and a plain wallet).
    let theirs = wrap_into(&mut env, &other.vault, LAMPORTS_PER_SOL);
    check(&mut env, sv::unwrap_wsol(&l.ph, theirs), e::INVALID_TOKEN_ACCOUNT);
    let wallet_ata = wrap_into(&mut env, &stranger.pubkey(), LAMPORTS_PER_SOL);
    check(&mut env, sv::unwrap_wsol(&l.ph, wallet_ata), e::INVALID_TOKEN_ACCOUNT);
    // Patched copies of the good account: frozen, not native, Token-2022-owned, wrong length.
    let base = env.account(&good).unwrap();
    let mut variants = vec![];
    let mut frozen = base.clone();
    frozen.data[108] = 2;
    variants.push(frozen);
    let mut not_native = base.clone();
    not_native.data[109..113].copy_from_slice(&[0, 0, 0, 0]);
    variants.push(not_native);
    variants.push(solana_account::Account { owner: TOKEN_2022, ..base.clone() });
    let mut long = base.clone();
    long.data.push(0);
    variants.push(long);
    for v in variants {
        let k = Address::new_unique();
        env.svm.set_account(k, v).unwrap();
        check(&mut env, sv::unwrap_wsol(&l.ph, k), e::INVALID_TOKEN_ACCOUNT);
    }
    // Wrong token program id.
    let mut ix = sv::unwrap_wsol(&l.ph, good);
    ix.accounts[3].pubkey = TOKEN_2022;
    check(&mut env, ix, e::INVALID_TOKEN_PROGRAM);
    // Wrong vault, read-only vault, fake state.
    let mut ix = sv::unwrap_wsol(&l.ph, good);
    ix.accounts[1].pubkey = other.vault;
    check(&mut env, ix, e::INVALID_VAULT);
    let mut ix = sv::unwrap_wsol(&l.ph, good);
    ix.accounts[1].is_writable = false;
    check(&mut env, ix, e::INVALID_VAULT);
    let mut ix = sv::unwrap_wsol(&l.ph, good);
    ix.accounts[0].pubkey = sv::config_pda().0;
    check(&mut env, ix, e::INVALID_VAULT_STATE);
    // Read-only WSOL account.
    let mut ix = sv::unwrap_wsol(&l.ph, good);
    ix.accounts[2].is_writable = false;
    check(&mut env, ix, e::ACCOUNT_NOT_WRITABLE);
    // Another place's state with this vault: the vault is re-derived from that state, so it does not match.
    let mut ix = sv::unwrap_wsol(&l.ph, good);
    ix.accounts[0].pubkey = other.state;
    check(&mut env, ix, e::INVALID_VAULT);
    // The good one still works.
    ok(env.send(&[sv::unwrap_wsol(&l.ph, good)], &stranger, &[]));
    let _ = Keypair::new();
}
