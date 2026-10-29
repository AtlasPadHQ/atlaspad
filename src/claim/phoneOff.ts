/**
 * Is the owner's phone check off in this build? Real mode only: /api/config `phoneVerification` 'none', or no config
 * yet on mainnet (it starts without Twilio; the default is RealClaimFlow's: devnet 'screen', mainnet 'none'). Copy that
 * would promise a phone call (place panel steps and About, launch review, Help) reads this, never the raw config.
 */
import { CLUSTER, IS_REAL } from '../mode';
import { useStore } from '../store';

export function usePhoneOff(): boolean {
  return useStore((s) => IS_REAL && (s.chain.config?.features.phoneVerification ?? (CLUSTER === 'devnet' ? 'screen' : 'none')) === 'none');
}
