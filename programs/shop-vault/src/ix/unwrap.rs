//! `unwrap_wsol` (disc 6, SPEC §5.7). Permissionless: closes a WSOL token account owned by the vault
//! with the vault as destination, so funds can only move *into* the vault (D7).

use pinocchio::{
    cpi::{invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

use crate::{
    consts::*,
    error::{err, VaultError},
    events::{emit, EV_UNWRAPPED},
    ix::{arr, require_len, require_writable},
    not_enough_accounts,
    pda::check_vault,
    state::{cast, check_state, VaultState},
};

/// Data: `[6]`. Accounts: `0 vault_state`, `1 vault (W)`, `2 wsol_account (W)`, `3 token_program`.
pub fn unwrap_wsol(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    require_len(data, 1)?;
    let [vault_state, vault, wsol_account, token_program, ..] = accounts else {
        return Err(not_enough_accounts());
    };

    check_state(vault_state, program_id, false)?;
    let (place_hash, vault_bump) = {
        let d = vault_state.try_borrow()?;
        // SAFETY: check_state verified the exact length.
        let st: &VaultState = unsafe { cast(&d) };
        (st.place_hash, st.vault_bump)
    };
    check_vault(vault, &place_hash, vault_bump, program_id)?;
    if token_program.address() != &SPL_TOKEN_PROGRAM {
        return Err(err(VaultError::InvalidTokenProgram));
    }
    if !wsol_account.owned_by(&SPL_TOKEN_PROGRAM) || wsol_account.data_len() != TOKEN_ACCOUNT_LEN {
        return Err(err(VaultError::InvalidTokenAccount));
    }
    {
        let data = wsol_account.try_borrow()?;
        let d = arr::<TOKEN_ACCOUNT_LEN>(&data, 0).ok_or_else(|| err(VaultError::InvalidTokenAccount))?;
        if &d[TA_MINT..TA_MINT + 32] != NATIVE_MINT.as_ref()
            || &d[TA_OWNER..TA_OWNER + 32] != vault.address().as_ref()
            || d[TA_STATE] != 1
            || d[TA_IS_NATIVE..TA_IS_NATIVE + 4] != [1, 0, 0, 0]
        {
            return Err(err(VaultError::InvalidTokenAccount));
        }
    }
    require_writable(wsol_account)?;
    let amount = wsol_account.lamports();

    // Token::CloseAccount { account: wsol (W), destination: vault (W), authority: vault (S) }.
    let metas = [
        InstructionAccount::writable(wsol_account.address()),
        InstructionAccount::writable(vault.address()),
        InstructionAccount::readonly_signer(vault.address()),
    ];
    let ix = InstructionView {
        program_id: &SPL_TOKEN_PROGRAM,
        data: &[TOKEN_IX_CLOSE_ACCOUNT],
        accounts: &metas,
    };
    let bump_arr = [vault_bump];
    let seeds = [Seed::from(SEED_VAULT), Seed::from(&place_hash), Seed::from(&bump_arr)];
    invoke_signed(&ix, &[&*wsol_account, &*vault, &*vault], &[Signer::from(&seeds)])?;

    emit(&[EV_UNWRAPPED, &place_hash, &amount.to_le_bytes()]);
    Ok(())
}
