/**
 * Second, independent gate in front of the attestor (defence in depth, INTEGRATION.md §3.4 steps 4-5): the shop-vault
 * client's own SPEC §8.4 checker (`checkLaunchMessage` / `checkClaimMessage`) over web3.js
 * `VersionedMessage.deserialize`, plus web3.js's byte-identical re-serialisation. worker/policy.ts must pass first;
 * the attestor signs only when BOTH return no violations.
 *
 * web3.js and the client are loaded with dynamic imports, so the bundle evaluates them lazily: only the two cosign
 * routes pay for them (≈2-3 ms CPU per check), every other route keeps a small cold start.
 */
import { bytesEq } from './bytes';
import type { LookupTable } from './policy';

interface RefLaunch {
  attestor: string;
  launcher: string;
  mint: string;
  placeId: string;
  name: string;
  symbol: string;
  uri: string;
  maxDevBuyLamports: bigint;
  alt: LookupTable | null;
  maxComputeUnitLimit: number;
  maxComputeUnitPriceMicroLamports: bigint;
  programId: string;
}

interface RefClaim {
  attestor: string;
  newOwner: string;
  placeId: string;
  expectedNonce: bigint;
  maxComputeUnitLimit: number;
  maxComputeUnitPriceMicroLamports: bigint;
  programId: string;
}

async function libs() {
  const [web3, sv] = await Promise.all([import('@solana/web3.js'), import('@cornershop/shop-vault-client')]);
  return { web3, sv };
}

/**
 * Evaluate web3.js + the shop-vault client now (≈50-90 ms CPU the first time in an isolate) so a co-sign that follows
 * does not pay it on its critical path: `/api/launch/prepare` and `/api/claim/check` call this in `waitUntil`, after
 * their response is sent, and the co-sign routes start it in parallel with their I/O (INTEGRATION §8: cosign ≤ 400 ms).
 */
export function warmReference(): Promise<void> {
  return libs().then(
    () => undefined,
    () => undefined,
  );
}

async function deserialize(bytes: Uint8Array) {
  const { web3, sv } = await libs();
  let msg: import('@solana/web3.js').VersionedMessage;
  try {
    msg = web3.VersionedMessage.deserialize(bytes);
  } catch {
    return { error: 'web3.js cannot deserialize the message' as const, web3, sv };
  }
  if (!bytesEq(msg.serialize(), bytes)) return { error: 'non-canonical message (web3.js re-serialisation differs)' as const, web3, sv };
  return { msg, web3, sv };
}

export async function referenceLaunchViolations(bytes: Uint8Array, p: RefLaunch): Promise<string[]> {
  const d = await deserialize(bytes);
  if ('error' in d) return [d.error!];
  const { msg, web3, sv } = d;
  const lookupTable = p.alt
    ? new web3.AddressLookupTableAccount({
        key: new web3.PublicKey(p.alt.address),
        state: {
          deactivationSlot: 0xffff_ffff_ffff_ffffn,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: p.alt.keys.map((k) => new web3.PublicKey(k)),
        },
      })
    : undefined;
  return sv.checkLaunchMessage(msg!, {
    attestor: new web3.PublicKey(p.attestor),
    launcher: new web3.PublicKey(p.launcher),
    mint: new web3.PublicKey(p.mint),
    placeId: p.placeId,
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    maxDevBuyLamports: p.maxDevBuyLamports,
    ...(lookupTable ? { lookupTable } : {}),
    maxComputeUnitLimit: p.maxComputeUnitLimit,
    maxComputeUnitPriceMicroLamports: p.maxComputeUnitPriceMicroLamports,
    programId: new web3.PublicKey(p.programId),
  });
}

export async function referenceClaimViolations(bytes: Uint8Array, p: RefClaim): Promise<string[]> {
  const d = await deserialize(bytes);
  if ('error' in d) return [d.error!];
  const { msg, web3, sv } = d;
  return sv.checkClaimMessage(msg!, {
    attestor: new web3.PublicKey(p.attestor),
    newOwner: new web3.PublicKey(p.newOwner),
    placeId: p.placeId,
    expectedNonce: p.expectedNonce,
    maxComputeUnitLimit: p.maxComputeUnitLimit,
    maxComputeUnitPriceMicroLamports: p.maxComputeUnitPriceMicroLamports,
    programId: new web3.PublicKey(p.programId),
  });
}
