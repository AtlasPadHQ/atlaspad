import { describe, expect, test } from 'vitest';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { WalletAccount } from '@wallet-standard/base';
import { DevnetTestWallet, TEST_WALLET_MARKER, TEST_WALLET_NAME } from './testWallet';

type Features = DevnetTestWallet['features'];

describe('Devnet Test Wallet (Wallet Standard)', () => {
  test('shape: name, devnet-only chain, features, marker', () => {
    const w = new DevnetTestWallet(() => {});
    expect(w.name).toBe(TEST_WALLET_NAME);
    expect(w.chains).toEqual(['solana:devnet']);
    expect(w.icon.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(Object.keys(w.features).sort()).toEqual(
      ['solana:signAndSendTransaction', 'solana:signMessage', 'solana:signTransaction', 'standard:connect', 'standard:disconnect', 'standard:events'].sort(),
    );
    expect(w.features['solana:signTransaction'].supportedTransactionVersions).toContain(0);
    expect(TEST_WALLET_MARKER).toBe('cs-devnet-test-wallet-v1');
  });

  test('connect (no prompt) → account; events fire; disconnect clears', async () => {
    const w = new DevnetTestWallet(() => {});
    w.topUpIfLow = async () => {}; // no network in unit tests
    const seen: number[] = [];
    const off = (w.features as Features)['standard:events'].on('change', ({ accounts }) => seen.push(accounts?.length ?? -1));
    const { accounts } = await w.features['standard:connect'].connect();
    expect(accounts.length).toBe(1);
    expect(new PublicKey(accounts[0].address).toBytes()).toEqual(Uint8Array.from(accounts[0].publicKey));
    expect(w.address).toBe(accounts[0].address);
    await w.features['standard:disconnect'].disconnect();
    expect(w.accounts.length).toBe(0);
    expect(seen).toEqual([1, 0]);
    off();
  });

  test('signTransaction keeps existing co-signatures and adds a valid wallet signature', async () => {
    const w = new DevnetTestWallet(() => {});
    w.topUpIfLow = async () => {};
    const { accounts } = await w.features['standard:connect'].connect();
    const me = new PublicKey(accounts[0].address);
    const other = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: me,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: me, lamports: 1 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([other]); // a co-signer first (like the attestor / mint)
    const coSig = Uint8Array.from(tx.signatures[1]);
    const [out] = await w.features['solana:signTransaction'].signTransaction({ account: accounts[0] as WalletAccount, transaction: tx.serialize(), chain: 'solana:devnet' });
    const signed = VersionedTransaction.deserialize(out.signedTransaction);
    expect(Buffer.from(signed.message.serialize()).equals(Buffer.from(msg.serialize()))).toBe(true);
    expect(Array.from(signed.signatures[1])).toEqual(Array.from(coSig));
    const key = await crypto.subtle.importKey('raw', me.toBytes() as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, signed.signatures[0] as BufferSource, msg.serialize() as BufferSource)).toBe(true);
    // Never on another chain.
    await expect(
      w.features['solana:signTransaction'].signTransaction({ account: accounts[0] as WalletAccount, transaction: tx.serialize(), chain: 'solana:mainnet' }),
    ).rejects.toThrow(/only signs on solana:devnet/);
  });

  test('signMessage returns a valid ed25519 signature', async () => {
    const w = new DevnetTestWallet(() => {});
    w.topUpIfLow = async () => {};
    const { accounts } = await w.features['standard:connect'].connect();
    const message = new TextEncoder().encode('cornershop devnet');
    const [out] = await w.features['solana:signMessage'].signMessage({ account: accounts[0] as WalletAccount, message });
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(accounts[0].publicKey) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, out.signature as BufferSource, message as BufferSource)).toBe(true);
  });

  test('refuses to sign before connect', async () => {
    const w = new DevnetTestWallet(() => {});
    await expect(
      w.features['solana:signTransaction'].signTransaction({ account: { address: 'x' } as unknown as WalletAccount, transaction: new Uint8Array(1) }),
    ).rejects.toThrow(/not connected/);
  });
});
