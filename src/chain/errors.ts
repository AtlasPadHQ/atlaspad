/**
 * Error mapping for every chain flow (INTEGRATION.md §4.8). The messages are FINAL COPY (DESIGN tone) and never
 * contain secrets, raw RPC URLs or raw program logs. Pure module (no web3.js), unit-tested in errors.test.ts.
 *
 * Rules:
 *  - Expected failures are thrown internally as `TxFail` and returned to callers as `{ ok: false, error }`.
 *  - `InstructionError: [i, { Custom: n }]` is decoded against the program that actually failed: the innermost
 *    "Program X failed: custom program error" log line when logs exist, else the top-level program of instruction i.
 *  - Never say "nothing was sent" once a signature exists (`sent: true`).
 */
import { RPC_WALLET_BLOCKED } from '../../worker/wire';
import { explorerTx } from './explorer';
import type { TxError, TxErrorCode } from './types';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, SHOP_VAULT_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022, TOKEN_PROGRAM } from './constants';

type ProgramKind = NonNullable<TxError['programError']>['program'];

/** Internal typed failure. `detail` may override the default copy (`message`) and carry extra fields. */
export class TxFail extends Error {
  readonly code: TxErrorCode;
  readonly detail: Partial<TxError>;
  constructor(code: TxErrorCode, detail: Partial<TxError> = {}) {
    super(detail.message ?? code);
    this.name = 'TxFail';
    this.code = code;
    this.detail = detail;
  }
}

/** Error thrown by our Worker API client (`src/chain/api.ts`): HTTP status + the `ApiErrorBody`. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: { error: string; message?: string; retryAfterSec?: number; violations?: string[]; existing?: TxError['existing']; reason?: string };
  constructor(status: number, body: ApiError['body']) {
    super(body?.message ?? body?.error ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export interface ErrorContext {
  sent: boolean;
  signature?: string;
  walletName?: string;
  /** For "You don't hold that many $TICKER." */
  ticker?: string;
  /** For "Not enough SOL. You need about {x} SOL." (lamports, total). */
  needLamports?: bigint;
}

const RETRYABLE: Record<TxErrorCode, boolean> = {
  rejected: false,
  'insufficient-sol': false,
  'insufficient-tokens': false,
  slippage: true,
  'price-impact': false,
  expired: true,
  taken: false,
  reserved: true,
  'not-launchable': false,
  paused: false,
  graduated: true,
  policy: true,
  'wallet-modified': true,
  'wallet-unsupported': false,
  'wrong-network': false,
  'rate-limited': true,
  network: true,
  unconfirmed: false,
  onchain: true,
  claim: false,
  uneconomic: false,
  unknown: true,
};

/** "0.0123" (2–4 significant decimals, rounded UP so the need is never understated). */
export function solNeedText(lamports: bigint): string {
  const sol = Number(lamports) / 1e9;
  if (sol >= 1) return (Math.ceil(sol * 100) / 100).toString();
  if (sol >= 0.01) return (Math.ceil(sol * 1000) / 1000).toString();
  return (Math.ceil(sol * 10_000) / 10_000).toString();
}

/** Default copy per code (INTEGRATION.md §4.8 table). */
export function defaultMessage(code: TxErrorCode, ctx: Partial<ErrorContext> = {}): string {
  const wallet = ctx.walletName || 'your wallet';
  switch (code) {
    case 'rejected':
      return `You cancelled in ${wallet}.`;
    case 'insufficient-sol':
      return ctx.needLamports && ctx.needLamports > 0n
        ? `Not enough SOL. You need about ${solNeedText(ctx.needLamports)} SOL.`
        : 'Not enough SOL in your wallet for this.';
    case 'insufficient-tokens':
      return ctx.ticker ? `You don't hold that many $${ctx.ticker}.` : "You don't hold that many tokens.";
    case 'slippage':
      return 'The price moved. Try again.';
    case 'price-impact':
      return 'That trade would move the price more than 15%. Try a smaller amount.';
    case 'expired':
      return "It didn't go through in time. Nothing was charged. Try again.";
    case 'taken':
      return 'Someone launched this shop first.';
    case 'reserved':
      return 'Someone else is launching this shop right now. Try again in a minute.';
    case 'not-launchable':
      return "This place can't have a coin.";
    case 'paused':
      return 'Launches are paused right now. Trading and claims still work.';
    case 'graduated':
      return 'This coin just graduated. Try again in a minute.';
    case 'policy':
      return "We couldn't approve this transaction. Please try again.";
    case 'wallet-modified':
      return "Your wallet changed the transaction, so it can't be sent. Try again, or use another wallet.";
    case 'wallet-unsupported':
      return "This wallet can't sign here. Try Phantom, Solflare or Backpack.";
    case 'wrong-network':
      return 'This page is on a different Solana network. Reload and try again.';
    case 'rate-limited':
      return 'Too many requests. Wait a few seconds and try again.';
    case 'network':
      return ctx.sent ? "We couldn't confirm it yet. Check the explorer." : "We couldn't reach the network. Nothing was sent.";
    case 'unconfirmed':
      return "We couldn't confirm it yet. Check the explorer.";
    case 'onchain':
      return 'The transaction failed on Solana. Nothing changed.';
    case 'claim':
      return "This claim can't go ahead right now.";
    case 'uneconomic':
      return 'The network fee is more than the fees waiting. Withdrawing now would cost you more than you receive.';
    case 'unknown':
    default:
      return ctx.sent ? 'Something went wrong. Check the explorer.' : 'Something went wrong. Nothing was sent.';
  }
}

/** Build the public TxError. `sent`/`signature` from ctx unless the failure carries its own. */
export function makeTxError(code: TxErrorCode, ctx: Partial<ErrorContext>, detail: Partial<TxError> = {}): TxError {
  const sent = detail.sent ?? ctx.sent ?? false;
  const signature = detail.signature ?? ctx.signature;
  // A network failure after sending is an unconfirmed transaction, never "nothing was sent".
  const finalCode: TxErrorCode = sent && code === 'network' ? 'unconfirmed' : code;
  const out: TxError = {
    code: finalCode,
    message: detail.message ?? defaultMessage(finalCode, { ...ctx, sent }),
    retryable: detail.retryable ?? RETRYABLE[finalCode],
    sent,
  };
  if (signature) {
    out.signature = signature;
    out.explorerUrl = detail.explorerUrl ?? explorerTx(signature);
  }
  if (detail.needLamports) out.needLamports = detail.needLamports;
  else if (ctx.needLamports && finalCode === 'insufficient-sol') out.needLamports = ctx.needLamports.toString();
  if (detail.programError) out.programError = detail.programError;
  if (detail.existing) out.existing = detail.existing;
  if (detail.logs) out.logs = detail.logs;
  return out;
}

/* ------------------------------------------------------------------------------------------ program errors */

const SHOP_VAULT_NAMES: Record<number, string> = {
  100: 'InvalidInstruction', 101: 'InvalidConfig', 102: 'InvalidVaultState', 103: 'InvalidVault', 104: 'NotUpgradeAuthority',
  105: 'AlreadyInitialized', 106: 'InvalidWindow', 107: 'InvalidAuthorityKey', 108: 'AttestorMismatch', 109: 'LaunchesPaused',
  110: 'AlreadyRegistered', 111: 'InvalidAccountState', 112: 'InvalidBondingCurve', 113: 'CreatorMismatch',
  114: 'UnsupportedCurve', 115: 'InvalidSystemProgram', 116: 'CurveNotFresh', 117: 'ClaimAlreadyPending',
  118: 'NoPendingClaim', 119: 'BadNonce', 120: 'SameOwner', 121: 'InvalidOwner', 122: 'ClaimWindowActive',
  123: 'ClaimWindowElapsed', 124: 'Unauthorized', 125: 'NoOwner', 126: 'NotOwner', 127: 'NothingToWithdraw',
  128: 'ArithmeticOverflow', 129: 'NoPendingRotation', 130: 'RotationNotReady', 131: 'NoPendingGovernance',
  132: 'InvalidTokenProgram', 133: 'InvalidTokenAccount', 134: 'AccountNotWritable', 135: 'InvalidInstructionsSysvar',
  136: 'AttestorScope', 137: 'GovernanceCancelLimit', 138: 'ProposalEscalated', 139: 'ProposalExpired',
};
const PUMP_NAMES: Record<number, string> = {
  6002: 'TooMuchSolRequired', 6003: 'TooLittleSolReceived', 6005: 'BondingCurveComplete', 6020: 'BuyZeroAmount',
  6021: 'NotEnoughTokensToBuy', 6023: 'NotEnoughTokensToSell', 6040: 'BuyNotEnoughSolToCoverRent',
  6041: 'BuyNotEnoughSolToCoverFees', 6042: 'BuySlippageBelowMinTokensOut',
};
const AMM_NAMES: Record<number, string> = {
  6001: 'ZeroBaseAmount', 6002: 'ZeroQuoteAmount', 6004: 'ExceededSlippage', 6016: 'BuyMoreBaseAmountThanPoolReserves',
  6039: 'BuyNotEnoughQuoteTokensToCoverFees', 6040: 'BuySlippageBelowMinBaseAmountOut',
};

function kindOf(programId: string | undefined): ProgramKind {
  switch (programId) {
    case SHOP_VAULT_PROGRAM:
      return 'shop_vault';
    case PUMP_PROGRAM:
      return 'pump';
    case PUMP_AMM_PROGRAM:
      return 'pump_amm';
    case SYSTEM_PROGRAM:
      return 'system';
    default:
      return 'other';
  }
}

export interface DecodedProgramError {
  program: ProgramKind;
  programId?: string;
  code: number;
  name?: string;
  index: number;
}

/** The innermost failing program id and its custom code, from the logs ("Program X failed: custom program error: 0x1"). */
function failingFromLogs(logs: readonly string[] | undefined): { programId: string; code: number } | null {
  if (!logs) return null;
  for (const l of logs) {
    const m = /^Program (\w{32,44}) failed: custom program error: 0x([0-9a-fA-F]+)/.exec(l);
    if (m) return { programId: m[1], code: parseInt(m[2], 16) };
  }
  return null;
}

/**
 * Decode a transaction error (`meta.err` / simulation `value.err`) to the failing program and code.
 * `programIds[i]` = the program of top-level instruction i.
 */
export function decodeProgramError(err: unknown, programIds: readonly string[], logs?: readonly string[]): DecodedProgramError | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (!Array.isArray(ie)) return null;
  const [index, inner] = ie;
  const custom = (inner as { Custom?: number } | null)?.Custom;
  if (typeof custom !== 'number') return null;
  const fromLogs = failingFromLogs(logs);
  const programId = fromLogs && fromLogs.code === custom ? fromLogs.programId : programIds[index];
  const program = kindOf(programId);
  const name =
    program === 'shop_vault' ? SHOP_VAULT_NAMES[custom] : program === 'pump' ? PUMP_NAMES[custom] : program === 'pump_amm' ? AMM_NAMES[custom] : undefined;
  return { program, programId, code: custom, index, ...(name ? { name } : {}) };
}

const CLAIM_COPY: Record<number, string> = {
  117: 'A claim for this shop is already in its public window.',
  118: "There's no claim waiting to be finalized.",
  119: 'This shop changed while you were claiming. Try again.',
  120: 'This wallet already owns this shop.',
  121: "This wallet can't be the shop's payout wallet. Use another wallet.",
  122: "The public window hasn't ended yet.",
  123: 'The public window for this claim has ended.',
  125: "This shop hasn't been claimed yet.",
  126: "Only the shop owner's wallet can withdraw.",
  127: "There's nothing to withdraw yet.",
};

/** Map a decoded program error (or a top-level runtime error) to a TxFail. */
export function failFromTxError(
  err: unknown,
  programIds: readonly string[],
  logs: readonly string[] | undefined,
  extra: Partial<TxError> = {},
): TxFail {
  const logList = logs ? [...logs].slice(-30) : undefined;
  const withLogs = { ...extra, ...(logList ? { logs: logList } : {}) };
  // Top-level runtime errors (strings or single-key objects).
  if (typeof err === 'string') {
    if (err === 'InsufficientFundsForFee' || err === 'AccountNotFound') return new TxFail('insufficient-sol', withLogs);
    if (err === 'BlockhashNotFound') return new TxFail('expired', withLogs);
  }
  if (err && typeof err === 'object' && 'InsufficientFundsForRent' in (err as object)) return new TxFail('insufficient-sol', withLogs);
  if (logs?.some((l) => /insufficient lamports/i.test(l))) return new TxFail('insufficient-sol', withLogs);

  const pe = decodeProgramError(err, programIds, logs);
  if (!pe) return new TxFail('onchain', withLogs);
  // Anchor 3012 AccountNotInitialized on the trader's token account: selling a coin the wallet doesn't hold.
  if ((pe.program === 'pump' || pe.program === 'pump_amm') && pe.code === 3012 && logs?.some((l) => /associated_user|user_base_token_account/.test(l))) {
    return new TxFail('insufficient-tokens', { ...withLogs, programError: { program: pe.program, code: pe.code, name: 'AccountNotInitialized' } });
  }
  const programError = { program: pe.program, code: pe.code, ...(pe.name ? { name: pe.name } : {}) };
  const d = { ...withLogs, programError };
  if (pe.program === 'shop_vault') {
    if (pe.code === 110) return new TxFail('taken', d);
    if (pe.code === 109) return new TxFail('paused', d);
    if (CLAIM_COPY[pe.code]) return new TxFail('claim', { ...d, message: CLAIM_COPY[pe.code], retryable: pe.code === 119 });
    return new TxFail('onchain', d);
  }
  if (pe.program === 'pump') {
    if (pe.code === 6002 || pe.code === 6003 || pe.code === 6042) return new TxFail('slippage', d);
    if (pe.code === 6005) return new TxFail('graduated', d);
    if (pe.code === 6023) return new TxFail('insufficient-tokens', d);
    if (pe.code === 6040 || pe.code === 6041) return new TxFail('insufficient-sol', d);
    return new TxFail('onchain', d);
  }
  if (pe.program === 'pump_amm') {
    if (pe.code === 6004 || pe.code === 6040) return new TxFail('slippage', d);
    if (pe.code === 6001) return new TxFail('insufficient-tokens', d);
    if (pe.code === 6039) return new TxFail('insufficient-sol', d);
    return new TxFail('onchain', d);
  }
  if (pe.program === 'system' && pe.code === 1) return new TxFail('insufficient-sol', d);
  // SPL Token / Token-2022 error 1 = InsufficientFunds (selling more than the account holds).
  if ((pe.programId === TOKEN_PROGRAM || pe.programId === TOKEN_2022) && pe.code === 1) return new TxFail('insufficient-tokens', d);
  return new TxFail('onchain', d);
}

/* ------------------------------------------------------------------------------------------ toTxError */

const REJECT_RE = /reject|cancel|denied|declined|closed|abort|dismiss/i;

/** True for "the user said no in the wallet" (EIP-1193 4001, Wallet Standard / adapter errors, plain messages). */
export function isWalletRejection(e: unknown): boolean {
  if (!e || typeof e !== 'object') return typeof e === 'string' && REJECT_RE.test(e);
  const x = e as { code?: unknown; name?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
  if (x.code === 4001 || x.error?.code === 4001) return true;
  const name = String(x.name ?? '');
  if (/UserRejected|WalletSignTransactionError|WalletSignMessageError/.test(name) && REJECT_RE.test(String(x.message ?? ''))) return true;
  if (name === 'UserRejectedRequestError') return true;
  return REJECT_RE.test(String(x.message ?? '')) && /user|request|approval|transaction|sign/i.test(String(x.message ?? ''));
}

function apiCode(status: number, body: ApiError['body']): { code: TxErrorCode; detail: Partial<TxError> } {
  const err = body?.error;
  switch (err) {
    case 'taken':
      return { code: 'taken', detail: body.existing ? { existing: body.existing } : {} };
    case 'reserved':
      return { code: 'reserved', detail: {} };
    case 'launches_paused':
      return { code: 'paused', detail: {} };
    case 'policy_violation':
      return { code: 'policy', detail: {} };
    case 'not_launchable': {
      const why =
        body.reason === 'closed'
          ? 'This business is marked as closed on Google.'
          : body.reason === 'not_found'
            ? "We couldn't find this place on Google."
            : 'Only open businesses can be launched.';
      return { code: 'not-launchable', detail: { message: why } };
    }
    case 'moderation':
      return { code: 'not-launchable', detail: { message: "That name or ticker isn't allowed. Try another." } };
    // sanctions (worker/geo.ts, worker/sanctions.ts): final, never retryable
    case 'place_region_blocked':
      return { code: 'not-launchable', detail: { message: body.message && body.message.length < 160 ? body.message : PLACE_REGION_BLOCKED_COPY } };
    case 'region_blocked':
      return { code: 'unknown', detail: { message: REGION_BLOCKED_COPY, retryable: false } };
    case 'wallet_blocked':
      return { code: 'unknown', detail: { message: WALLET_BLOCKED_COPY, retryable: false } };
    case 'place_opted_out':
      return { code: 'not-launchable', detail: { message: "This business asked us not to list coins for it, so it can't be launched." } };
    case 'rate_limited':
    case 'too_many_attempts':
    case 'faucet_cap':
      return { code: 'rate-limited', detail: err === 'too_many_attempts' ? { message: 'Too many attempts. Try again later.' } : {} };
    case 'reservation_expired':
      return { code: 'expired', detail: { message: 'This launch took too long to approve. Try again.' } };
    case 'chain_mismatch':
      return { code: 'wrong-network', detail: {} };
    case 'claim_pending':
      return { code: 'claim', detail: { message: 'A claim for this shop is already in its public window.' } };
    case 'claim_active':
      return { code: 'claim', detail: { message: 'Someone is verifying this shop right now. Try again in a few minutes.', retryable: true } };
    case 'already_owner':
      return { code: 'claim', detail: { message: 'This wallet already owns this shop.' } };
    case 'wrong_owner':
      return { code: 'claim', detail: { message: 'Use the same wallet you started this claim with.' } };
    case 'claim_expired':
    case 'claim_not_verified':
      return { code: 'claim', detail: { message: 'Your verification expired. Start the claim again.' } };
    case 'no_coin':
      return { code: 'claim', detail: { message: "This shop doesn't have a coin yet." } };
    case 'not_confirmed':
      return { code: 'onchain', detail: {} };
    case 'payload_too_large':
    case 'unsupported_media':
      return { code: 'unknown', detail: { message: 'That image is too big or not a PNG, JPEG or WebP. Try another.', retryable: false } };
    case 'bad_request':
      return { code: 'unknown', detail: {} };
    default:
      if (status === 429) return { code: 'rate-limited', detail: {} };
      if (status >= 500 || status === 0) return { code: 'network', detail: {} };
      return { code: 'unknown', detail: {} };
  }
}

export const REGION_BLOCKED_COPY = "AtlasPad isn't available in your region.";
export const PLACE_REGION_BLOCKED_COPY = "AtlasPad isn't available for businesses in this region.";
export const WALLET_BLOCKED_COPY = "This wallet can't be used on AtlasPad.";

/** Shape check so ApiError-like errors from other modules (src/realdata/api.ts) map the same way. */
function asApiError(e: unknown): ApiError | null {
  if (e instanceof ApiError) return e;
  const x = e as { status?: unknown; body?: { error?: unknown } } | null;
  if (x && typeof x === 'object' && typeof x.status === 'number' && x.body && typeof x.body.error === 'string') return x as ApiError;
  return null;
}

/** Anything thrown by a chain flow → TxError (INTEGRATION.md §4.2: `toTxError(e, ctx)`). */
export function toTxError(e: unknown, ctx: Partial<ErrorContext> & { sent: boolean }): TxError {
  if (e instanceof TxFail) return makeTxError(e.code, ctx, e.detail);
  if (isWalletRejection(e)) return makeTxError('rejected', ctx);
  const api = asApiError(e);
  if (api) {
    const { code, detail } = apiCode(api.status, api.body);
    return makeTxError(code, ctx, detail);
  }
  const rpc = e as { name?: string; code?: unknown; message?: unknown; httpStatus?: unknown } | null;
  if (rpc && rpc.name === 'RpcError') {
    if (rpc.code === RPC_WALLET_BLOCKED) return makeTxError('unknown', ctx, { message: WALLET_BLOCKED_COPY, retryable: false, sent: false });
    if (rpc.code === -32005 || rpc.httpStatus === 429) return makeTxError('rate-limited', ctx);
    if (/blockhash not found|block height exceeded/i.test(String(rpc.message))) return makeTxError('expired', ctx);
    return makeTxError('network', ctx);
  }
  const msg = String((e as { message?: unknown })?.message ?? e ?? '');
  if (/failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(msg)) return makeTxError('network', ctx);
  if (/blockhash not found|block height exceeded/i.test(msg)) return makeTxError('expired', ctx);
  if (/not available in demo mode/i.test(msg)) return makeTxError('unknown', ctx, { message: 'Real transactions are off in the demo.', retryable: false });
  return makeTxError('unknown', ctx);
}
