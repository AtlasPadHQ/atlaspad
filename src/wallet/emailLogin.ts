/**
 * Whether "Continue with email" may show (INTEGRATION.md §1.9). Pure.
 *
 * The email screens in WalletPicker are the demo's MOCK embedded wallet: no email is sent, the code is the fixed demo
 * code (271 604), and the address is a deterministic fake that cannot sign. No Privy SDK or adapter exists in this codebase,
 * so in real mode (devnet and mainnet) email login stays hidden even when the Worker reports `features.privy`
 * (PRIVY_APP_ID set): setting that id alone must never put a wallet that can't sign in front of real users.
 * Flip PRIVY_ADAPTER_BUILT only together with a real Privy integration.
 */
export const PRIVY_ADAPTER_BUILT = false;

export function emailLoginAvailable(isReal: boolean, privyConfigured: boolean): boolean {
  if (!isReal) return true; // demo: the mocked embedded wallet is the point
  return PRIVY_ADAPTER_BUILT && privyConfigured;
}
