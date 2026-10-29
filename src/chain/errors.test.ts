import { describe, expect, test } from 'vitest';
import { ApiError, decodeProgramError, failFromTxError, isWalletRejection, toTxError, TxFail } from './errors';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, SHOP_VAULT_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022 } from './constants';

const CB = 'ComputeBudget111111111111111111111111111111';
const launchIds = [CB, CB, PUMP_PROGRAM, SHOP_VAULT_PROGRAM, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', PUMP_PROGRAM];
const ie = (i: number, code: number) => ({ InstructionError: [i, { Custom: code }] });

describe('program error decoding (INTEGRATION.md §4.8)', () => {
  test('shop-vault 110 / 109 at register_launch → taken / paused', () => {
    expect(failFromTxError(ie(3, 110), launchIds, undefined).code).toBe('taken');
    expect(failFromTxError(ie(3, 109), launchIds, undefined).code).toBe('paused');
    expect(decodeProgramError(ie(3, 110), launchIds)).toMatchObject({ program: 'shop_vault', code: 110, name: 'AlreadyRegistered' });
  });

  test('pump slippage / graduated / insufficient', () => {
    for (const c of [6002, 6003, 6042]) expect(failFromTxError(ie(5, c), launchIds, undefined).code).toBe('slippage');
    expect(failFromTxError(ie(2, 6005), [CB, CB, PUMP_PROGRAM], undefined).code).toBe('graduated');
    expect(failFromTxError(ie(2, 6023), [CB, CB, PUMP_PROGRAM], undefined).code).toBe('insufficient-tokens');
    expect(failFromTxError(ie(2, 6040), [CB, CB, PUMP_PROGRAM], undefined).code).toBe('insufficient-sol');
  });

  test('pump-amm slippage and zero base', () => {
    expect(failFromTxError(ie(3, 6004), [CB, CB, 'x', PUMP_AMM_PROGRAM], undefined).code).toBe('slippage');
    expect(failFromTxError(ie(3, 6040), [CB, CB, 'x', PUMP_AMM_PROGRAM], undefined).code).toBe('slippage');
    expect(failFromTxError(ie(3, 6001), [CB, CB, 'x', PUMP_AMM_PROGRAM], undefined).code).toBe('insufficient-tokens');
  });

  test('selling a coin the wallet holds none of (Anchor 3012 on the user token account) → insufficient-tokens', () => {
    const logs = [
      `Program ${PUMP_AMM_PROGRAM} invoke [1]`,
      'Program log: AnchorError caused by account: user_base_token_account. Error Code: AccountNotInitialized. Error Number: 3012.',
      `Program ${PUMP_AMM_PROGRAM} failed: custom program error: 0xbc4`,
    ];
    expect(failFromTxError(ie(3, 3012), [CB, CB, 'x', PUMP_AMM_PROGRAM], logs).code).toBe('insufficient-tokens');
    expect(failFromTxError(ie(3, 3012), [CB, CB, 'x', PUMP_AMM_PROGRAM], ['other account']).code).toBe('onchain');
  });

  test('the innermost failing program from the logs wins over the top-level program', () => {
    const logs = [
      `Program ${PUMP_PROGRAM} invoke [1]`,
      `Program ${TOKEN_2022} invoke [2]`,
      `Program ${TOKEN_2022} failed: custom program error: 0x1`,
      `Program ${PUMP_PROGRAM} failed: custom program error: 0x1`,
    ];
    const f = failFromTxError(ie(2, 1), [CB, CB, PUMP_PROGRAM], logs);
    expect(f.code).toBe('insufficient-tokens');
    expect(f.detail.logs?.length).toBe(4);
  });

  test('runtime errors', () => {
    expect(failFromTxError('InsufficientFundsForFee', [], undefined).code).toBe('insufficient-sol');
    expect(failFromTxError('AccountNotFound', [], undefined).code).toBe('insufficient-sol');
    expect(failFromTxError({ InsufficientFundsForRent: { account_index: 0 } }, [], undefined).code).toBe('insufficient-sol');
    expect(failFromTxError('BlockhashNotFound', [], undefined).code).toBe('expired');
    expect(failFromTxError(ie(0, 1), [SYSTEM_PROGRAM], ['Transfer: insufficient lamports 5, need 10']).code).toBe('insufficient-sol');
  });

  test('claim-related shop-vault errors carry final copy', () => {
    const f = failFromTxError(ie(2, 122), [CB, CB, SHOP_VAULT_PROGRAM], undefined);
    expect(f.code).toBe('claim');
    expect(toTxError(f, { sent: false }).message).toBe("The public window hasn't ended yet.");
    expect(toTxError(failFromTxError(ie(0, 126), [SHOP_VAULT_PROGRAM], undefined), { sent: true, signature: 'sig' }).message).toBe(
      "Only the shop owner's wallet can withdraw.",
    );
  });

  test('anything else on-chain → onchain', () => {
    expect(failFromTxError(ie(2, 9999), [CB, CB, 'Other111111111111111111111111111111111111111'], undefined).code).toBe('onchain');
    expect(failFromTxError({ InstructionError: [1, 'InvalidAccountData'] }, launchIds, undefined).code).toBe('onchain');
  });
});

describe('toTxError copy and sent semantics', () => {
  test('wallet rejection', () => {
    expect(isWalletRejection({ code: 4001, message: 'User rejected the request.' })).toBe(true);
    expect(isWalletRejection(new Error('User rejected the request'))).toBe(true);
    expect(isWalletRejection({ name: 'WalletSignTransactionError', message: 'Transaction cancelled' })).toBe(true);
    expect(isWalletRejection(new Error('Approval Denied by user'))).toBe(true);
    expect(isWalletRejection(new Error('fetch failed'))).toBe(false);
    const e = toTxError({ code: 4001 }, { sent: false, walletName: 'Phantom' });
    expect(e).toMatchObject({ code: 'rejected', message: 'You cancelled in Phantom.', retryable: false, sent: false });
  });

  test('API errors', () => {
    const taken = toTxError(new ApiError(409, { error: 'taken', existing: { mint: 'M', ticker: 'KEBAB', placeId: 'p' } }), { sent: false });
    expect(taken).toMatchObject({ code: 'taken', existing: { ticker: 'KEBAB' } });
    expect(toTxError(new ApiError(409, { error: 'reserved' }), { sent: false })).toMatchObject({
      code: 'reserved',
      retryable: true,
      message: 'Someone else is launching this shop right now. Try again in a minute.',
    });
    expect(toTxError(new ApiError(423, { error: 'launches_paused' }), { sent: false }).code).toBe('paused');
    expect(toTxError(new ApiError(422, { error: 'policy_violation', violations: ['x'] }), { sent: false })).toMatchObject({
      code: 'policy',
      message: "We couldn't approve this transaction. Please try again.",
    });
    expect(toTxError(new ApiError(422, { error: 'not_launchable', reason: 'closed' }), { sent: false }).message).toBe('This business is marked as closed on Google.');
    // a business that opted out (scripts/moderate.mjs --optout) gets no coin: final, not retryable
    expect(toTxError(new ApiError(422, { error: 'place_opted_out' }), { sent: false })).toMatchObject({
      code: 'not-launchable',
      retryable: false,
      message: "This business asked us not to list coins for it, so it can't be launched.",
    });
    expect(toTxError(new ApiError(429, { error: 'rate_limited' }), { sent: false }).code).toBe('rate-limited');
    expect(toTxError(new ApiError(503, { error: 'unavailable' }), { sent: false }).code).toBe('network');
    // Duck-typed ApiError from src/realdata/api.ts maps the same way.
    expect(toTxError({ status: 409, body: { error: 'taken' } }, { sent: false }).code).toBe('taken');
  });

  test('network errors never claim "nothing was sent" after a signature exists', () => {
    const before = toTxError(new TypeError('Failed to fetch'), { sent: false });
    expect(before).toMatchObject({ code: 'network', message: "We couldn't reach the network. Nothing was sent.", sent: false });
    const after = toTxError(new TypeError('Failed to fetch'), { sent: true, signature: '5sig' });
    expect(after.code).toBe('unconfirmed');
    expect(after.message).not.toMatch(/nothing was sent/i);
    expect(after.explorerUrl).toContain('5sig');
  });

  test('RPC errors', () => {
    const rate = Object.assign(new Error('rate limited'), { name: 'RpcError', code: -32005 });
    expect(toTxError(rate, { sent: false }).code).toBe('rate-limited');
    const bh = Object.assign(new Error('Blockhash not found'), { name: 'RpcError', code: -32002 });
    expect(toTxError(bh, { sent: false }).code).toBe('expired');
  });

  test('insufficient SOL shows the need', () => {
    const e = toTxError(new TxFail('insufficient-sol'), { sent: false, needLamports: 123_456_789n });
    expect(e.message).toBe('Not enough SOL. You need about 0.124 SOL.');
    expect(e.needLamports).toBe('123456789');
  });

  test('expired copy and retryable flags', () => {
    expect(toTxError(new TxFail('expired', { sent: true, signature: 's' }), { sent: true })).toMatchObject({
      code: 'expired',
      retryable: true,
      message: "It didn't go through in time. Nothing was charged. Try again.",
    });
    expect(toTxError(new TxFail('price-impact'), { sent: false }).retryable).toBe(false);
    expect(toTxError(new TxFail('wallet-unsupported'), { sent: false }).message).toBe("This wallet can't sign here. Try Phantom, Solflare or Backpack.");
  });
});
