/**
 * INTEGRATION.md §11.1 (2): one @solana/web3.js copy for the app, the chain layer and the shop-vault client
 * (`.npmrc install-links=true`). Two copies would make `instanceof PublicKey` checks inside web3.js fail at runtime.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';

describe('dependency wiring', () => {
  it('the shop-vault client and the app share one web3.js copy', () => {
    expect(sv.SHOP_VAULT_PROGRAM_ID instanceof PublicKey).toBe(true);
    expect(sv.SHOP_VAULT_PROGRAM_ID.toBase58()).toBe('6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x');
  });
});
