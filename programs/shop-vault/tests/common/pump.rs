//! pump.fun instruction builders, encoded from the IDL in @pump-fun/pump-sdk 3.2.0 (`src/idl/pump.json`) and the
//! account choices of its builders (`sdk.ts`: createV2Instruction, tradeV3Accounts, getBuyV2InstructionInternal,
//! getSellV2InstructionInternal, sweepBondingCurveFeeAccounts). They run against the real mainnet `pump.so`.
#![allow(dead_code)]

use solana_address::{address, Address};
use solana_instruction::{AccountMeta, Instruction};

pub const PUMP: Address = address!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_FEES: Address = address!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const PUMP_AMM: Address = address!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const MAYHEM: Address = address!("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
pub const TOKEN_2022: Address = address!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SPL_TOKEN: Address = address!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ATA_PROGRAM: Address = address!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = Address::new_from_array([0; 32]);
pub const NATIVE_MINT: Address = address!("So11111111111111111111111111111111111111112");
pub const USDC: Address = address!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

pub const GLOBAL: Address = address!("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
pub const FEE_CONFIG: Address = address!("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
pub const EVENT_AUTHORITY: Address = address!("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
pub const MINT_AUTHORITY: Address = address!("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
pub const GLOBAL_PARAMS: Address = address!("13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ");
pub const SOL_VAULT: Address = address!("BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s");
pub const QUOTE_CONTROL: Address = address!("6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP");
pub const GLOBAL_VOLUME_ACC: Address = address!("Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y");
pub const FEE_RECIPIENT: Address = address!("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
pub const BUYBACK_RECIPIENT: Address = address!("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");
pub const PUMP_FEES_EVENT_AUTHORITY: Address = address!("D6QxXDt6hhcCpto4HiZKkN2YQ2iZRF5R7S3caCHpUsML");
pub const PUMP_AMM_EVENT_AUTHORITY: Address = address!("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");

/// `sha256("event:TradeEvent")[..8]`, after anchor's `emit_cpi!` tag `e445a52e51cb9a1d`.
pub const EVENT_IX_TAG: [u8; 8] = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
pub const TRADE_EVENT_DISC: [u8; 8] = [0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee];

pub fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}
pub fn bonding_curve(mint: &Address) -> Address {
    pda(&[b"bonding-curve", mint.as_ref()], &PUMP)
}
pub fn creator_vault(creator: &Address) -> Address {
    pda(&[b"creator-vault", creator.as_ref()], &PUMP)
}
pub fn user_volume_accumulator(user: &Address) -> Address {
    pda(&[b"user_volume_accumulator", user.as_ref()], &PUMP)
}
pub fn sharing_config(mint: &Address) -> Address {
    pda(&[b"sharing-config", mint.as_ref()], &PUMP_FEES)
}
pub fn mayhem_state(mint: &Address) -> Address {
    pda(&[b"mayhem-state", mint.as_ref()], &MAYHEM)
}
pub fn ata(owner: &Address, mint: &Address, token_program: &Address) -> Address {
    pda(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM)
}
pub fn wsol_ata(owner: &Address) -> Address {
    ata(owner, &NATIVE_MINT, &SPL_TOKEN)
}

fn ro(a: Address) -> AccountMeta {
    AccountMeta::new_readonly(a, false)
}
fn w(a: Address) -> AccountMeta {
    AccountMeta::new(a, false)
}
fn ws(a: Address) -> AccountMeta {
    AccountMeta::new(a, true)
}

fn borsh_str(d: &mut Vec<u8>, s: &str) {
    d.extend_from_slice(&(s.len() as u32).to_le_bytes());
    d.extend_from_slice(s.as_bytes());
}

#[derive(Clone)]
pub struct CreateArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub creator: Address,
    pub mayhem: bool,
    pub holder_reward: bool,
    /// Non-SOL quote: (quote mint, quote token program).
    pub quote: Option<(Address, Address)>,
}

impl CreateArgs {
    pub fn sol(creator: Address) -> Self {
        Self {
            name: "Corner Cafe".into(),
            symbol: "CAFE".into(),
            uri: "https://cornershop-devnet.tiejiucai.workers.dev/m/abcdefghijklmnop.json".into(),
            creator,
            mayhem: false,
            holder_reward: false,
            quote: None,
        }
    }
}

/// `create_v2(name, symbol, uri, creator, is_mayhem_mode, OptionBool cashback, OptionU64 creator_fee_bps,
/// OptionBool holder_reward)` with the 16 IDL accounts (+4 remaining accounts for a token quote).
pub fn create_v2(mint: Address, user: Address, a: &CreateArgs) -> Instruction {
    let mut d = vec![0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4];
    borsh_str(&mut d, &a.name);
    borsh_str(&mut d, &a.symbol);
    borsh_str(&mut d, &a.uri);
    d.extend_from_slice(a.creator.as_ref());
    d.push(a.mayhem as u8);
    d.push(0); // cashback: false (deprecated, 6082)
    d.extend_from_slice(&0u64.to_le_bytes()); // creator_fee_bps (ignored for SOL quotes)
    d.push(a.holder_reward as u8);
    let curve = bonding_curve(&mint);
    let mut accounts = vec![
        AccountMeta::new(mint, true),
        ro(MINT_AUTHORITY),
        w(curve),
        w(ata(&curve, &mint, &TOKEN_2022)),
        ro(GLOBAL),
        ws(user),
        ro(SYSTEM),
        ro(TOKEN_2022),
        ro(ATA_PROGRAM),
        w(MAYHEM),
        ro(GLOBAL_PARAMS),
        w(SOL_VAULT),
        w(mayhem_state(&mint)),
        w(ata(&SOL_VAULT, &mint, &TOKEN_2022)),
        ro(EVENT_AUTHORITY),
        ro(PUMP),
    ];
    if let Some((qm, qp)) = a.quote {
        accounts.push(ro(qm));
        accounts.push(w(ata(&curve, &qm, &qp)));
        accounts.push(ro(qp));
        accounts.push(ro(QUOTE_CONTROL));
    }
    Instruction { program_id: PUMP, accounts, data: d }
}

/// The 17 accounts `buy_v3` / `buy_exact_quote_in_v3` / `sell_v3` share on a SOL curve.
fn trade_v3_accounts(user: Address, mint: Address) -> Vec<AccountMeta> {
    let curve = bonding_curve(&mint);
    vec![
        ro(GLOBAL),
        ro(mint),
        ro(NATIVE_MINT),
        ro(TOKEN_2022),
        ro(SPL_TOKEN),
        w(curve),
        w(ata(&curve, &mint, &TOKEN_2022)),
        w(wsol_ata(&curve)),
        ws(user),
        w(ata(&user, &mint, &TOKEN_2022)),
        w(wsol_ata(&user)),
        w(user_volume_accumulator(&user)),
        ro(FEE_CONFIG),
        w(BUYBACK_RECIPIENT),
        ro(SYSTEM),
        ro(EVENT_AUTHORITY),
        ro(PUMP),
    ]
}

/// `buy_exact_quote_in_v3(spendable_quote_in, min_tokens_out, partial_fill=false)`.
pub fn buy_exact_quote_in_v3(user: Address, mint: Address, spend: u64, min_tokens_out: u64) -> Instruction {
    let mut d = vec![0xe1, 0xf7, 0x50, 0x1e, 0xd5, 0xb3, 0x84, 0x88];
    d.extend_from_slice(&spend.to_le_bytes());
    d.extend_from_slice(&min_tokens_out.to_le_bytes());
    d.push(0);
    Instruction { program_id: PUMP, accounts: trade_v3_accounts(user, mint), data: d }
}

/// `sell_v3(amount, min_sol_output)`.
pub fn sell_v3(user: Address, mint: Address, amount: u64, min_sol_output: u64) -> Instruction {
    let mut d = vec![0x1c, 0x92, 0xde, 0x77, 0x26, 0xc4, 0x69, 0xd5];
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&min_sol_output.to_le_bytes());
    Instruction { program_id: PUMP, accounts: trade_v3_accounts(user, mint), data: d }
}

fn trade_v2_accounts(user: Address, mint: Address, creator: Address, buy: bool) -> Vec<AccountMeta> {
    let curve = bonding_curve(&mint);
    let cv = creator_vault(&creator);
    let uva = user_volume_accumulator(&user);
    let mut v = vec![
        ro(GLOBAL),
        ro(mint),
        ro(NATIVE_MINT),
        ro(TOKEN_2022),
        ro(SPL_TOKEN),
        ro(ATA_PROGRAM),
        w(FEE_RECIPIENT),
        w(wsol_ata(&FEE_RECIPIENT)),
        w(BUYBACK_RECIPIENT),
        w(wsol_ata(&BUYBACK_RECIPIENT)),
        w(curve),
        w(ata(&curve, &mint, &TOKEN_2022)),
        w(wsol_ata(&curve)),
        ws(user),
        w(ata(&user, &mint, &TOKEN_2022)),
        w(wsol_ata(&user)),
        w(cv),
        w(wsol_ata(&cv)),
        ro(sharing_config(&mint)),
    ];
    if buy {
        v.push(ro(GLOBAL_VOLUME_ACC));
    }
    v.extend([
        w(uva),
        w(wsol_ata(&uva)),
        ro(FEE_CONFIG),
        ro(PUMP_FEES),
        ro(SYSTEM),
        ro(EVENT_AUTHORITY),
        ro(PUMP),
    ]);
    v
}

/// `buy_v2(amount, max_sol_cost, partial_fill=false)`; v1/v2 trades pay the creator vault directly.
pub fn buy_v2(user: Address, mint: Address, creator: Address, amount: u64, max_sol_cost: u64) -> Instruction {
    let mut d = vec![0xb8, 0x17, 0xee, 0x61, 0x67, 0xc5, 0xd3, 0x3d];
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&max_sol_cost.to_le_bytes());
    d.push(0);
    Instruction { program_id: PUMP, accounts: trade_v2_accounts(user, mint, creator, true), data: d }
}

/// `sell_v2(amount, min_sol_output)`.
pub fn sell_v2(user: Address, mint: Address, creator: Address, amount: u64, min_sol_output: u64) -> Instruction {
    let mut d = vec![0x5d, 0xf6, 0x82, 0x3c, 0xe7, 0xe9, 0x40, 0xb2];
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&min_sol_output.to_le_bytes());
    Instruction { program_id: PUMP, accounts: trade_v2_accounts(user, mint, creator, false), data: d }
}

/// `sweep_creator_fee`: moves the v3 curve bucket into `creator_vault(creator)`. Permissionless.
pub fn sweep_creator_fee(payer: Address, mint: Address, creator: Address) -> Instruction {
    let curve = bonding_curve(&mint);
    let cv = creator_vault(&creator);
    Instruction {
        program_id: PUMP,
        accounts: vec![
            ws(payer),
            ro(GLOBAL),
            ro(mint),
            ro(NATIVE_MINT),
            ro(SPL_TOKEN),
            ro(ATA_PROGRAM),
            ro(SYSTEM),
            w(curve),
            w(wsol_ata(&curve)),
            w(cv),
            w(wsol_ata(&cv)),
            ro(EVENT_AUTHORITY),
            ro(PUMP),
        ],
        data: vec![0x20, 0xf6, 0xbf, 0x34, 0x08, 0xc9, 0x49, 0xba],
    }
}

/// `collect_creator_fee`: pays `creator_vault(creator)` to `creator`. The creator does not sign.
pub fn collect_creator_fee(creator: Address) -> Instruction {
    Instruction {
        program_id: PUMP,
        accounts: vec![w(creator), w(creator_vault(&creator)), ro(SYSTEM), ro(EVENT_AUTHORITY), ro(PUMP)],
        data: vec![0x14, 0x16, 0x56, 0x7b, 0xc6, 0x1c, 0xdb, 0x84],
    }
}

/// pump_fees `create_fee_sharing_config` (accounts as built by the SDK for a curve coin).
pub fn create_fee_sharing_config(payer: Address, mint: Address) -> Instruction {
    Instruction {
        program_id: PUMP_FEES,
        accounts: vec![
            ro(PUMP_FEES_EVENT_AUTHORITY),
            ro(PUMP_FEES),
            ws(payer),
            ro(GLOBAL),
            ro(mint),
            w(sharing_config(&mint)),
            ro(SYSTEM),
            w(bonding_curve(&mint)),
            ro(PUMP),
            ro(EVENT_AUTHORITY),
            ro(PUMP_FEES),
            ro(PUMP_AMM),
            ro(PUMP_AMM_EVENT_AUTHORITY),
        ],
        data: vec![0xc3, 0x4e, 0x56, 0x4c, 0x6f, 0x34, 0xfb, 0xd5],
    }
}

/// `set_metaplex_creator` (mint, metadata, bonding_curve, event_authority, program).
pub fn set_metaplex_creator(mint: Address) -> Instruction {
    let metaplex = address!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
    let metadata = pda(&[b"metadata", metaplex.as_ref(), mint.as_ref()], &metaplex);
    Instruction {
        program_id: PUMP,
        accounts: vec![ro(mint), ro(metadata), w(bonding_curve(&mint)), ro(EVENT_AUTHORITY), ro(PUMP)],
        data: vec![0x8a, 0x60, 0xae, 0xd9, 0x30, 0x55, 0xc5, 0xf6],
    }
}

/// ATA program `CreateIdempotent`.
pub fn create_ata_idempotent(payer: Address, owner: Address, mint: Address, token_program: Address) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            ws(payer),
            w(ata(&owner, &mint, &token_program)),
            ro(owner),
            ro(mint),
            ro(SYSTEM),
            ro(token_program),
        ],
        data: vec![1],
    }
}

/// Decoded BondingCurve prefix (offsets as in SPEC §2).
#[derive(Debug, Clone)]
pub struct Curve {
    pub virtual_token_reserves: u64,
    pub virtual_quote_reserves: u64,
    pub real_token_reserves: u64,
    pub real_quote_reserves: u64,
    pub complete: bool,
    pub creator: Address,
    pub is_mayhem: bool,
    pub is_cashback: bool,
    pub quote_mint: Address,
    pub is_holder_reward: bool,
    pub creator_fee_bucket: u64,
}

impl Curve {
    pub fn decode(d: &[u8]) -> Self {
        let u = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        let k = |o: usize| Address::new_from_array(d[o..o + 32].try_into().unwrap());
        Self {
            virtual_token_reserves: u(8),
            virtual_quote_reserves: u(16),
            real_token_reserves: u(24),
            real_quote_reserves: u(32),
            complete: d[48] != 0,
            creator: k(49),
            is_mayhem: d[81] != 0,
            is_cashback: d[82] != 0,
            quote_mint: k(83),
            is_holder_reward: d[124] != 0,
            creator_fee_bucket: u(125),
        }
    }
}

/// `TradeEvent` fields we assert on, decoded from anchor `emit_cpi!` inner-instruction data
/// (`EVENT_IX_TAG ‖ TRADE_EVENT_DISC ‖ borsh`), fixed offsets up to `creator_fee`.
#[derive(Debug, Clone)]
pub struct TradeEvent {
    pub mint: Address,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub is_buy: bool,
    pub creator: Address,
    pub creator_fee: u64,
}

impl TradeEvent {
    pub fn try_decode(data: &[u8]) -> Option<Self> {
        if data.len() < 16 + 217 || data[..8] != EVENT_IX_TAG || data[8..16] != TRADE_EVENT_DISC {
            return None;
        }
        let d = &data[16..];
        let u = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        let k = |o: usize| Address::new_from_array(d[o..o + 32].try_into().unwrap());
        // mint 0, sol 32, token 40, is_buy 48, user 49, ts 81, vsr 89, vtr 97, rsr 105, rtr 113,
        // fee_recipient 121, fee_bps 153, fee 161, creator 169, creator_fee_bps 201, creator_fee 209
        Some(Self {
            mint: k(0),
            sol_amount: u(32),
            token_amount: u(40),
            is_buy: d[48] != 0,
            creator: k(169),
            creator_fee: u(209),
        })
    }
}
