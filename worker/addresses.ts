/**
 * Address derivations for shop-vault and pump (async PDA math from worker/pda.ts). Mirrors
 * programs/shop-vault/client/src/pda.ts and @pump-fun/pump-sdk 3.2.0 `pda.ts` (checked in worker/addresses.test.ts).
 */
import { b58decode, fromHex, toHex, utf8 } from './bytes';
import {
  ATA_PROGRAM,
  MAYHEM_PROGRAM,
  MAYHEM_SOL_VAULT,
  NATIVE_MINT,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from './consts';
import { pda } from './pda';

/** `place_hash = sha256(utf8(placeId))` (bare Places (New) id, no prefix, no normalisation). */
export async function placeHash(placeId: string): Promise<Uint8Array> {
  if (!placeId) throw new Error('placeId is empty');
  if (placeId.startsWith('places/')) throw new Error('pass the bare place.id');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(placeId)));
}

export async function placeHashHex(placeId: string): Promise<string> {
  return toHex(await placeHash(placeId));
}

export const vaultPda = (ph: Uint8Array, programId: string) => pda(['vault', check32(ph)], programId);
export const vaultStatePda = (ph: Uint8Array, programId: string) => pda(['vault_state', check32(ph)], programId);
export const configPda = (programId: string) => pda(['config'], programId);

function check32(h: Uint8Array): Uint8Array {
  if (h.length !== 32) throw new Error('place hash must be 32 bytes');
  return h;
}

export const ata = (owner: string, mint: string, tokenProgram: string) =>
  pda([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA_PROGRAM);

export const bondingCurvePda = (mint: string) => pda(['bonding-curve', b58decode(mint)], PUMP_PROGRAM);
export const pumpCreatorVaultPda = (creator: string) => pda(['creator-vault', b58decode(creator)], PUMP_PROGRAM);
export const userVolumeAccumulatorPda = (user: string) => pda(['user_volume_accumulator', b58decode(user)], PUMP_PROGRAM);
export const mayhemStatePda = (mint: string) => pda(['mayhem-state', b58decode(mint)], MAYHEM_PROGRAM);
export const mayhemTokenVault = (mint: string) => ata(MAYHEM_SOL_VAULT, mint, TOKEN_2022_PROGRAM);
export const pumpPoolAuthorityPda = (mint: string) => pda(['pool-authority', b58decode(mint)], PUMP_PROGRAM);
export const ammCreatorVaultAuthority = (creator: string) => pda(['creator_vault', b58decode(creator)], PUMP_AMM_PROGRAM);
export const eventAuthorityPda = (programId: string) => pda(['__event_authority'], programId);

/** The vault's WSOL ATA (pump-amm `collect_coin_creator_fee` target; `unwrap_wsol`). */
export const vaultWsolAta = (vault: string) => ata(vault, NATIVE_MINT, SPL_TOKEN_PROGRAM);

/** pump-amm coin-creator WSOL vault ATA for a graduated coin whose creator is `vault`. */
export async function ammCreatorVaultAta(vault: string): Promise<string> {
  return ata(await ammCreatorVaultAuthority(vault), NATIVE_MINT, SPL_TOKEN_PROGRAM);
}

/** Canonical PumpSwap pool: PDA(["pool", u16le(0), poolAuthority(mint), mint, WSOL], pump-amm). */
export async function canonicalPoolPda(mint: string): Promise<string> {
  const auth = await pumpPoolAuthorityPda(mint);
  return pda(['pool', Uint8Array.of(0, 0), b58decode(auth), b58decode(mint), b58decode(NATIVE_MINT)], PUMP_AMM_PROGRAM);
}

/** Every per-place address. */
export async function placeAddresses(placeId: string, programId: string) {
  const ph = await placeHash(placeId);
  return { placeHash: ph, placeHashHex: toHex(ph), vault: await vaultPda(ph, programId), vaultState: await vaultStatePda(ph, programId) };
}

export async function placeAddressesFromHash(placeHashHex: string, programId: string) {
  const ph = fromHex(placeHashHex);
  return { placeHash: ph, placeHashHex, vault: await vaultPda(ph, programId), vaultState: await vaultStatePda(ph, programId) };
}

/** pump curve token accounts: base (Token-2022 mint) and quote (WSOL, SPL Token). */
export const curveBaseAta = (bondingCurve: string, mint: string) => ata(bondingCurve, mint, TOKEN_2022_PROGRAM);
export const curveQuoteAta = (bondingCurve: string) => ata(bondingCurve, NATIVE_MINT, SPL_TOKEN_PROGRAM);

/** Every address a launch transaction must use (SPEC §8.1, pump IDL 3.2.0 account lists). */
export interface LaunchAddresses {
  placeHash: Uint8Array;
  placeHashHex: string;
  vault: string;
  vaultState: string;
  config: string;
  bondingCurve: string;
  curveBaseAta: string;
  curveQuoteAta: string;
  mayhemState: string;
  mayhemTokenVault: string;
  launcherAta: string;
  launcherWsolAta: string;
  userVolumeAccumulator: string;
}

export async function launchAddresses(placeHashBytes: Uint8Array, launcher: string, mint: string, programId: string): Promise<LaunchAddresses> {
  const ph = check32(placeHashBytes);
  const bondingCurve = await bondingCurvePda(mint);
  const [vault, vaultState, config, cBase, cQuote, mState, mVault, lAta, lWsol, uva] = await Promise.all([
    vaultPda(ph, programId),
    vaultStatePda(ph, programId),
    configPda(programId),
    curveBaseAta(bondingCurve, mint),
    curveQuoteAta(bondingCurve),
    mayhemStatePda(mint),
    mayhemTokenVault(mint),
    ata(launcher, mint, TOKEN_2022_PROGRAM),
    ata(launcher, NATIVE_MINT, SPL_TOKEN_PROGRAM),
    userVolumeAccumulatorPda(launcher),
  ]);
  return {
    placeHash: ph,
    placeHashHex: toHex(ph),
    vault,
    vaultState,
    config,
    bondingCurve,
    curveBaseAta: cBase,
    curveQuoteAta: cQuote,
    mayhemState: mState,
    mayhemTokenVault: mVault,
    launcherAta: lAta,
    launcherWsolAta: lWsol,
    userVolumeAccumulator: uva,
  };
}
