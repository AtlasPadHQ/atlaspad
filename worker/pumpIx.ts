/**
 * Hand-encoded instructions the Worker's crank sends (INTEGRATION §3.7 fee crank, SPEC §8.3; pump IDL 3.2.0 and
 * pump-amm IDL 2.1.0 account lists). worker/pumpIx.test.ts compares them with the SDK builders' account metas; the
 * SDK itself is a devDependency only and never bundled into the Worker.
 */
import { fromHex } from './bytes';
import { ammCreatorVaultAuthority, ata, bondingCurvePda, curveQuoteAta, pumpCreatorVaultPda } from './addresses';
import {
  ATA_PROGRAM,
  DISC,
  NATIVE_MINT,
  PUMP_AMM_EVENT_AUTHORITY,
  PUMP_AMM_PROGRAM,
  PUMP_EVENT_AUTHORITY,
  PUMP_GLOBAL,
  PUMP_PROGRAM,
  SHOP_VAULT_IX,
  SPL_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
} from './consts';
import type { Instruction } from './txbuild';

const w = (pubkey: string, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: string) => ({ pubkey, isSigner: false, isWritable: false });

/** pump `sweep_creator_fee`: curve bucket → pump creator vault of `creator` (permissionless). */
export async function sweepCreatorFeeIx(payer: string, mint: string, creator: string): Promise<Instruction> {
  const bc = await bondingCurvePda(mint);
  const recipient = await pumpCreatorVaultPda(creator);
  return {
    programId: PUMP_PROGRAM,
    keys: [
      w(payer, true),
      r(PUMP_GLOBAL),
      r(mint),
      r(NATIVE_MINT),
      r(SPL_TOKEN_PROGRAM),
      r(ATA_PROGRAM),
      r(SYSTEM_PROGRAM),
      w(bc),
      w(await curveQuoteAta(bc)),
      w(recipient),
      w(await ata(recipient, NATIVE_MINT, SPL_TOKEN_PROGRAM)),
      r(PUMP_EVENT_AUTHORITY),
      r(PUMP_PROGRAM),
    ],
    data: fromHex(DISC.pumpSweepCreatorFee),
  };
}

/** pump `collect_creator_fee(creator = vault)`: pump creator vault → the shop vault (permissionless). */
export async function collectCreatorFeeIx(creator: string): Promise<Instruction> {
  return {
    programId: PUMP_PROGRAM,
    keys: [w(creator), w(await pumpCreatorVaultPda(creator)), r(SYSTEM_PROGRAM), r(PUMP_EVENT_AUTHORITY), r(PUMP_PROGRAM)],
    data: fromHex(DISC.pumpCollectCreatorFee),
  };
}

/** pump-amm `transfer_creator_fees_to_pump` (no signer): AMM WSOL creator vault → pump creator vault. */
export async function transferCreatorFeesToPumpIx(coinCreator: string): Promise<Instruction> {
  const auth = await ammCreatorVaultAuthority(coinCreator);
  return {
    programId: PUMP_AMM_PROGRAM,
    keys: [
      r(NATIVE_MINT),
      r(SPL_TOKEN_PROGRAM),
      r(SYSTEM_PROGRAM),
      r(ATA_PROGRAM),
      r(coinCreator),
      w(auth),
      w(await ata(auth, NATIVE_MINT, SPL_TOKEN_PROGRAM)),
      w(await pumpCreatorVaultPda(coinCreator)),
      r(PUMP_AMM_EVENT_AUTHORITY),
      r(PUMP_AMM_PROGRAM),
    ],
    data: fromHex(DISC.ammTransferCreatorFeesToPump),
  };
}

/** shop-vault `finalize_claim` (permissionless): `[4]`, accounts `[vault_state W]`. */
export function finalizeClaimIx(programId: string, vaultState: string): Instruction {
  return { programId, keys: [w(vaultState)], data: Uint8Array.of(SHOP_VAULT_IX.finalizeClaim) };
}
