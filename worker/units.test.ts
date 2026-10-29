/**
 * Unit tests for the Worker's pure modules: PDA math vs web3.js, hand-encoded crank instructions vs the pump SDK,
 * the legacy tx compiler vs web3.js, account / event decoders, image sniffing, moderation, history math, website
 * SSRF rules, category parity with the app, and the D1 rate counters.
 */
import './test/globals';
import { describe, expect, it } from 'vitest';
import { ata, bondingCurvePda, canonicalPoolPda, configPda, launchAddresses, mayhemStatePda, pumpCreatorVaultPda, userVolumeAccumulatorPda, vaultPda, vaultStatePda, vaultWsolAta } from './addresses';
import { b58encode, fromB64, toB64, toHex } from './bytes';
import { categoryFromGoogle } from './categories';
import { altProblems, decodeAlt, decodeConfig, decodePumpGlobal, decodeVaultState } from './chainState';
import { computeFees } from './coins';
import { ALT_KEYS, CONFIG_PDA, NATIVE_MINT, SHOP_VAULT_PROGRAM_ID, TOKEN_2022_PROGRAM } from './consts';
import { cap, DAY } from './ctx';
import { decodePumpEvents, decodeVaultLogEvents, evHex, evKey, evU64 } from './events';
import { change24h, priceHistory } from './history';
import { sniffImage } from './images';
import { moderationHit } from './moderation';
import { isOnCurve } from './pda';
import { collectCreatorFeeIx, finalizeClaimIx, sweepCreatorFeeIx, transferCreatorFeesToPumpIx } from './pumpIx';
import { compileLegacy, systemTransfer } from './txbuild';
import { decodeMessage, encodeMessage } from './txcodec';
import type { Deps } from './ctx';
import { findOwnershipProof, isIpLiteral, isOwnSiteHost, MULTI_TENANT_SUFFIXES, multiTenantSuffix, registrableDomain, safeUrl } from './website';
import { isOwnBusinessHost, launchIneligibility, PLATFORM_HOSTS } from './wire';
import { altData, configData, tradeEventIxData, vaultStateData } from './test/fakeChain';
import { FakeD1 } from './test/fakeD1';
import { prng, pump, sv, web3 } from './test/launchFixture';

const pk = () => web3.Keypair.generate().publicKey;

describe('PDA math (no web3.js in the Worker)', () => {
  it('isOnCurve agrees with web3.js on random and derived bytes', () => {
    const rnd = prng(1234);
    for (let i = 0; i < 300; i++) {
      const b = Uint8Array.from({ length: 32 }, () => Math.floor(rnd() * 256));
      expect(isOnCurve(b), toHex(b)).toBe(web3.PublicKey.isOnCurve(b));
    }
    for (let i = 0; i < 50; i++) expect(isOnCurve(pk().toBytes())).toBe(true);
  });

  it('derives the same addresses as the shop-vault client and the pump SDK', async () => {
    const s = await sv();
    expect(await configPda(SHOP_VAULT_PROGRAM_ID)).toBe(CONFIG_PDA);
    for (let i = 0; i < 5; i++) {
      const placeId = `ChIJtestplace${i}xxxxxxx`;
      const ph = s.placeHash(placeId);
      expect(await vaultPda(ph, SHOP_VAULT_PROGRAM_ID)).toBe(s.vaultPda(ph)[0].toBase58());
      expect(await vaultStatePda(ph, SHOP_VAULT_PROGRAM_ID)).toBe(s.vaultStatePda(ph)[0].toBase58());
      const mint = pk();
      const vault = s.vaultPda(ph)[0];
      expect(await bondingCurvePda(mint.toBase58())).toBe(pump.bondingCurvePda(mint).toBase58());
      expect(await pumpCreatorVaultPda(vault.toBase58())).toBe(s.pumpCreatorVaultPda(vault).toBase58());
      expect(await vaultWsolAta(vault.toBase58())).toBe(s.vaultWsolAta(vault).toBase58());
      expect(await mayhemStatePda(mint.toBase58())).toBe(pump.getMayhemStatePda(mint).toBase58());
      const user = pk();
      expect(await userVolumeAccumulatorPda(user.toBase58())).toBe(pump.userVolumeAccumulatorPda(user).toBase58());
      expect(await ata(user.toBase58(), mint.toBase58(), TOKEN_2022_PROGRAM)).toBe(s.associatedTokenAddress(user, mint, s.TOKEN_2022_PROGRAM_ID).toBase58());
      expect(await canonicalPoolPda(mint.toBase58())).toBe(pump.canonicalPumpPoolPda(mint).toBase58());
    }
    const la = await launchAddresses(s.placeHash('ChIJN1t_tDeuEmsRUsoyG83frY4'), pk().toBase58(), pk().toBase58(), SHOP_VAULT_PROGRAM_ID);
    expect(la.placeHashHex).toBe('52791f4bf8f035bc928405e161a4c28a262db717cfe91ae8d3615563066afa15');
  });
});

describe('crank instructions vs the SDK builders (account metas + data)', () => {
  const metas = (ix: { keys: { pubkey: any; isSigner: boolean; isWritable: boolean }[] }) =>
    ix.keys.map((k) => [typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58(), k.isSigner, k.isWritable]);

  it('sweep_creator_fee', async () => {
    const sdk = new pump.PumpSdk();
    const payer = pk();
    const mint = pk();
    const creator = pk();
    const ref = await sdk.sweepCreatorFeeInstruction({ payer, mint, creator, quoteMint: new web3.PublicKey(NATIVE_MINT) });
    const mine = await sweepCreatorFeeIx(payer.toBase58(), mint.toBase58(), creator.toBase58());
    expect(metas(mine)).toEqual(metas(ref));
    expect(toHex(mine.data)).toBe(toHex(new Uint8Array(ref.data)));
  });

  it('collect_creator_fee', async () => {
    const sdk = new pump.PumpSdk();
    const creator = pk();
    const ref = await sdk.offlinePumpProgram.methods.collectCreatorFee().accountsPartial({ creator }).instruction();
    const mine = await collectCreatorFeeIx(creator.toBase58());
    expect(metas(mine)).toEqual(metas(ref));
    expect(toHex(mine.data)).toBe(toHex(new Uint8Array(ref.data)));
  });

  it('pump-amm transfer_creator_fees_to_pump', async () => {
    const sdk = new pump.PumpSdk();
    const creator = pk();
    const ref = await sdk.offlinePumpAmmProgram.methods
      .transferCreatorFeesToPump()
      .accountsPartial({ wsolMint: new web3.PublicKey(NATIVE_MINT), tokenProgram: new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), coinCreator: creator })
      .instruction();
    const mine = await transferCreatorFeesToPumpIx(creator.toBase58());
    expect(metas(mine)).toEqual(metas(ref));
    expect(toHex(mine.data)).toBe(toHex(new Uint8Array(ref.data)));
  });

  it('finalize_claim matches the shop-vault client', async () => {
    const s = await sv();
    const ph = s.placeHash('ChIJfinalize00000001');
    const ref = s.finalizeClaim({ placeHash: ph });
    const mine = finalizeClaimIx(SHOP_VAULT_PROGRAM_ID, s.vaultStatePda(ph)[0].toBase58());
    expect(metas(mine)).toEqual(metas(ref));
    expect(toHex(mine.data)).toBe(toHex(new Uint8Array(ref.data)));
  });
});

describe('legacy tx compiler', () => {
  it('compiles exactly like web3.js (System transfer + compute budget)', () => {
    const from = pk();
    const to = pk();
    const bh = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const mine = encodeMessage(compileLegacy(from.toBase58(), [systemTransfer(from.toBase58(), to.toBase58(), 123_456_789n)], bh));
    const ref = new web3.Transaction({ feePayer: from, recentBlockhash: bh }).add(web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 123_456_789 })).compileMessage().serialize();
    expect(toHex(mine)).toBe(toHex(new Uint8Array(ref)));
    expect(decodeMessage(mine).version).toBe('legacy');
  });
});

describe('account decoders', () => {
  it('Config, VaultState, ALT, pump Global', () => {
    const att = pk().toBase58();
    const c = decodeConfig(configData({ attestor: att, guardian: pk().toBase58(), governance: pk().toBase58(), window: 60, paused: true, probationUntil: 1_800_000_000 }));
    expect(c).toMatchObject({ attestor: att, paused: true, flavor: 'devnet', claimWindowSecs: 60, probationUntil: 1_800_000_000 });
    const owner = pk().toBase58();
    const v = decodeVaultState(vaultStateData({ placeHashHex: 'ab'.repeat(32), mint: pk().toBase58(), launcher: pk().toBase58(), pending: { owner, unlockTs: 1_800_000_060, inProbation: true }, nonce: 3n, totalWithdrawn: 42n }));
    expect(v).toMatchObject({ placeHash: 'ab'.repeat(32), owner: null, pendingOwner: owner, unlockTs: 1_800_000_060, inProbation: true, claimNonce: 3n, totalWithdrawn: 42n });
    expect(() => decodeVaultState(new Uint8Array(208))).toThrow();
    expect(altProblems(decodeAlt(altData()))).toEqual([]);
    expect(altProblems(decodeAlt(altData(ALT_KEYS, false)))).toEqual(['lookup table is not frozen']);
    expect(altProblems(decodeAlt(altData([...ALT_KEYS].reverse())))).toEqual(['lookup table does not hold exactly ALT_KEYS']);
    expect(altProblems(null)).toEqual(['lookup table not found']);
    const g = new Uint8Array(1088);
    new DataView(g.buffer).setBigUint64(73, 1_073_000_000_000_000n, true);
    new DataView(g.buffer).setBigUint64(81, 30_000_000_000n, true);
    new DataView(g.buffer).setBigUint64(1005, 4_292_000n, true); // non-SOL quote mints only: ignored for SOL coins
    expect(decodePumpGlobal(g).initialVirtualQuoteReserves).toBe(30_000_000_000n);
  });

  it('fees waiting: exact lamports, never negative (SPEC §8.5)', () => {
    const acc = (lamports: bigint) => ({ lamports, owner: '1', data: new Uint8Array(0), executable: false });
    const rent = { r0: 890_880n, rState: 2_338_560n, rToken: 2_039_280n };
    const f = computeFees({ vault: acc(890_880n + 5n), vaultState: acc(2_338_560n + 7n), pumpCreatorVault: acc(890_880n + 11n), curveBucket: 13n, vaultWsol: acc(2_039_280n + 17n), ammCreatorVault: null }, rent, 100n);
    expect(f).toEqual({ withdrawableNow: 12n, collectable: 11n + 13n + 2_039_297n, waiting: 12n + 11n + 13n + 2_039_297n, withdrawn: 100n, earned: 100n + 12n + 11n + 13n + 2_039_297n });
    const empty = computeFees({ vault: acc(1n), vaultState: null, pumpCreatorVault: null, curveBucket: 0n, vaultWsol: null, ammCreatorVault: null }, rent, 0n);
    expect(empty.waiting).toBe(0n);
    // graduated: pump-amm Pool.creator_fees count as collectable (CHAIN finding #3)
    const grad = computeFees({ vault: acc(890_880n), vaultState: null, pumpCreatorVault: null, curveBucket: 0n, vaultWsol: null, ammCreatorVault: null, poolCreatorFees: 4_321n }, rent, 0n);
    expect(grad).toMatchObject({ collectable: 4_321n, waiting: 4_321n, earned: 4_321n });
  });
});

describe('event decoding', () => {
  it('pump TradeEvent from inner instructions; failed txs carry nothing', () => {
    const mint = pk().toBase58();
    const user = pk().toBase58();
    const creator = pk().toBase58();
    const data = tradeEventIxData({ mint, sol: 5n, tokens: 7n, isBuy: false, user, ts: 1_791_000_000, vSol: 1_000n, vTok: 2_000n, rSol: 3n, rTok: 4n, creator, creatorFee: 9n });
    const tx = {
      slot: 1,
      blockTime: 1,
      meta: { err: null, fee: 0, preBalances: [], postBalances: [], innerInstructions: [{ index: 2, instructions: [{ programIdIndex: 1, accounts: [], data }] }], logMessages: [], loadedAddresses: { writable: [], readonly: [] } },
      transaction: { signatures: [], message: { accountKeys: [user, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [], recentBlockhash: '' } },
    };
    const ev = decodePumpEvents(tx);
    expect(ev).toEqual([{ kind: 'curve', index: 0, mint, solAmount: 5n, tokenAmount: 7n, isBuy: false, user, timestamp: 1_791_000_000, virtualSol: 1_000n, virtualToken: 2_000n, realSol: 3n, realToken: 4n, creator, creatorFee: 9n, fee: 0n }]);
    expect(decodePumpEvents({ ...tx, meta: { ...tx.meta, err: { InstructionError: [0, 'x'] } } })).toEqual([]);
    // the same bytes under another program id are ignored
    expect(decodePumpEvents({ ...tx, transaction: { ...tx.transaction, message: { ...tx.transaction.message, accountKeys: [user, pk().toBase58()] } } })).toEqual([]);
  });

  it('shop-vault log events only while the program itself is running', () => {
    const P = SHOP_VAULT_PROGRAM_ID;
    const ph = new Uint8Array(32).fill(7);
    const owner = pk();
    const seg = (b: Uint8Array) => toB64(b);
    const nonce = new Uint8Array(8);
    nonce[0] = 2;
    const logs = [
      `Program ${P} invoke [1]`,
      `Program data: ${seg(new TextEncoder().encode('ClaimRequested'))} ${seg(ph)} ${seg(owner.toBytes())} ${seg(nonce)} ${seg(new Uint8Array(8))}`,
      `Program ${P} success`,
      `Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]`,
      `Program data: ${seg(new TextEncoder().encode('Registered'))} ${seg(ph)}`,
      `Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success`,
    ];
    const ev = decodeVaultLogEvents(logs, P);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.name).toBe('ClaimRequested');
    expect(evHex(ev[0]!.fields[0])).toBe('07'.repeat(32));
    expect(evKey(ev[0]!.fields[1])).toBe(owner.toBase58());
    expect(evU64(ev[0]!.fields[2])).toBe(2n);
  });
});

describe('images, moderation, launch rules', () => {
  it('sniffs PNG / JPEG / WebP headers and refuses GIF / SVG', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 2, 0]);
    expect(sniffImage(png)).toEqual({ type: 'image/png', width: 512, height: 512, ext: 'png' });
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 0, 2, 0, 3, 1, 0x11, 0]);
    expect(sniffImage(jpg)).toEqual({ type: 'image/jpeg', width: 512, height: 256, ext: 'jpg' });
    const webp = new Uint8Array(40);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
    webp.set([0xff, 0x01, 0x00, 0xff, 0x01, 0x00], 24);
    expect(sniffImage(webp)).toEqual({ type: 'image/webp', width: 512, height: 512, ext: 'webp' });
    expect(sniffImage(new TextEncoder().encode('GIF89a......................'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });

  it('moderation catches impersonation / scams / slurs without Scunthorpe misfires', () => {
    for (const bad of ['Official Kebab', '0FFICIAL', 'Free SOL giveaway', 'SOL', 'pump.fun cafe', 'Solana Barbers']) expect(moderationHit(bad), bad).not.toBeNull();
    for (const ok of ['Spice Bar', 'Grape Vine Pub', 'Pretty Nails', 'Pineapple Pizza', 'Raccoon Cafe', 'Pakistani Kitchen', 'Costa Coffee Mare Street', 'Solace Cafe', 'Scunthorpe Chippy']) expect(moderationHit(ok), ok).toBeNull();
  });

  it('launch eligibility + own-domain hosts (Phase-1 minors #3, #4)', () => {
    expect(launchIneligibility({ businessStatus: 'OPERATIONAL', primaryType: 'cafe', types: ['cafe'] })).toBeNull();
    expect(launchIneligibility({ primaryType: 'plus_code' })).toBe('not_business');
    expect(launchIneligibility({ types: ['locality', 'political'] })).toBe('not_business');
    expect(launchIneligibility({ businessStatus: 'CLOSED_PERMANENTLY', primaryType: 'cafe' })).toBe('closed');
    expect(isOwnBusinessHost('www.tripadvisor.co.uk')).toBe(false);
    expect(isOwnBusinessHost('mycafe.co.uk')).toBe(true);
  });

  it('category mapping matches the app (src/lib/categories)', async () => {
    // non-literal specifier: keeps the DOM-typed app module out of the worker typecheck (vitest resolves it at run time)
    const appPath = ['..', 'src', 'lib', 'categories'].join('/');
    const appCategory = ((await import(/* @vite-ignore */ appPath)) as { categoryFromGoogle: (p: string | null, t: string[]) => string }).categoryFromGoogle;
    const cases: [string | null, string[]][] = [
      ['coffee_shop', []],
      ['indian_restaurant', ['cafe', 'bar']],
      [null, ['establishment', 'kebab_shop']],
      ['barber_shop', []],
      ['convenience_store', []],
      ['gym', ['point_of_interest']],
      ['pub', []],
    ];
    for (const [p, t] of cases) expect(categoryFromGoogle(p, t)).toBe(appCategory(p, t));
  });
});

describe('history + 24 h change', () => {
  it('buckets are forward-filled from the seed; the newest bucket is the current price', () => {
    const now = Date.UTC(2026, 9, 8, 12, 10);
    const start = Math.floor(now / 1_800_000) * 1_800_000 - 47 * 1_800_000;
    const { history, historyAt } = priceHistory([{ ts: start + 10, price: 2 }, { ts: start + 1_800_000 * 10 + 5, price: 3 }], 1, 4, now);
    expect(history).toHaveLength(48);
    expect(history[0]).toBe(2);
    expect(history[9]).toBe(2);
    expect(history[10]).toBe(3);
    expect(history[46]).toBe(3);
    expect(history[47]).toBe(4);
    expect(historyAt).toBe(Math.floor(now / 1_800_000) * 1_800_000);
    expect(priceHistory([], 5, 0, now).history.every((x) => x === 5)).toBe(true);
    expect(change24h(110, 100)).toBe(10);
    expect(change24h(1, 3)).toBe(-66.7);
    expect(change24h(1, null)).toBeNull();
  });
});

describe('website verification SSRF rules', () => {
  it('registrable domains, IP literals, scheme/port/host rules', () => {
    expect(registrableDomain('shop.mycafe.co.uk')).toBe('mycafe.co.uk');
    expect(registrableDomain('www.example.com')).toBe('example.com');
    for (const h of ['127.0.0.1', '2130706433', '0x7f.1', '[::1]', '10.0.0.1']) expect(isIpLiteral(h), h).toBe(true);
    expect(safeUrl('https://www.mycafe.co.uk/', 'mycafe.co.uk')).not.toBeNull();
    expect(safeUrl('http://www.mycafe.co.uk/', 'mycafe.co.uk')).toBeNull();
    expect(safeUrl('https://www.mycafe.co.uk:8443/', 'mycafe.co.uk')).toBeNull();
    expect(safeUrl('https://user:pw@www.mycafe.co.uk/', 'mycafe.co.uk')).toBeNull();
    expect(safeUrl('https://evil.example/', 'mycafe.co.uk')).toBeNull();
    expect(safeUrl('https://127.0.0.1/', '127.0.0.1')).toBeNull();
    expect(safeUrl('https://router.local/', 'router.local')).toBeNull();
    expect(safeUrl('https://www.facebook.com/mycafe', 'facebook.com')).toBeNull();
  });

  it('a multi-tenant hosting suffix is a public suffix: the customer in front of it is the registrable domain', () => {
    const tenants: [string, string][] = [
      ['rosies.netlify.app', 'rosies.netlify.app'],
      ['www.rosies.github.io', 'rosies.github.io'],
      ['preview-12.rosies.pages.dev', 'rosies.pages.dev'],
      ['api.rosies.workers.dev', 'rosies.workers.dev'],
      ['rosies.vercel.app', 'rosies.vercel.app'],
      ['rosies.web.app', 'rosies.web.app'],
      ['rosies.firebaseapp.com', 'rosies.firebaseapp.com'],
      ['rosies.herokuapp.com', 'rosies.herokuapp.com'],
      ['rosies.myshopify.com', 'rosies.myshopify.com'],
      ['rosies.godaddysites.com', 'rosies.godaddysites.com'],
      ['rosies.webflow.io', 'rosies.webflow.io'],
      ['rosies.squarespace.com', 'rosies.squarespace.com'],
      ['rosies.ueniweb.com', 'rosies.ueniweb.com'],
      ['rosies.wixstudio.io', 'rosies.wixstudio.io'],
      ['rosies.wixsite.com', 'rosies.wixsite.com'],
      ['rosies.blogspot.com', 'rosies.blogspot.com'],
      // one label deeper: App Engine regions, Azure Static Web Apps partitions, Elastic Beanstalk regions
      ['rosies.uc.r.appspot.com', 'rosies.uc.r.appspot.com'],
      ['v2.rosies.ew.r.appspot.com', 'rosies.ew.r.appspot.com'],
      ['rosies.appspot.com', 'rosies.appspot.com'],
      ['nice-sky-0abc.2.azurestaticapps.net', 'nice-sky-0abc.2.azurestaticapps.net'],
      ['nice-sky-0abc.westeurope.azurestaticapps.net', 'nice-sky-0abc.westeurope.azurestaticapps.net'],
      ['nice-sky-0abc.azurestaticapps.net', 'nice-sky-0abc.azurestaticapps.net'],
      ['rosies.eu-west-2.elasticbeanstalk.com', 'rosies.eu-west-2.elasticbeanstalk.com'],
      ['rosies.hs-sites-eu1.com', 'rosies.hs-sites-eu1.com'],
      ['rosies.up.railway.app', 'rosies.up.railway.app'],
    ];
    for (const [host, domain] of tenants) expect(registrableDomain(host), host).toBe(domain);
    // a bare suffix stays itself; ordinary and country domains are unchanged
    expect(registrableDomain('netlify.app')).toBe('netlify.app');
    expect(registrableDomain('co.uk')).toBe('co.uk');
    expect(registrableDomain('shop.rosies.co.uk')).toBe('rosies.co.uk');
    expect(registrableDomain('notnetlify.app')).toBe('notnetlify.app');
    expect(multiTenantSuffix('evilnetlify.app')).toBeNull();
    expect(multiTenantSuffix('www.rosies.github.io')).toBe('github.io');
    expect(MULTI_TENANT_SUFFIXES.length).toBe(new Set(MULTI_TENANT_SUFFIXES).size);
    expect(PLATFORM_HOSTS.length).toBe(new Set(PLATFORM_HOSTS).size);
  });

  it('own-business hosts: a customer subdomain counts, the bare platform and path-hosted pages never do', () => {
    for (const ok of ['rosies.netlify.app', 'www.rosies.github.io', 'rosies.pages.dev', 'rosies.vercel.app', 'rosies.myshopify.com', 'rosies.webflow.io', 'pub-1a2b.r2.dev', 'rosies.co.uk']) {
      expect(isOwnSiteHost(ok), ok).toBe(true);
      expect(isOwnBusinessHost(ok), ok).toBe(true);
    }
    // the Worker refuses a bare public suffix; the claim UI's lighter check leaves that to the Worker
    for (const bare of [
      'netlify.app', 'www.netlify.app', 'github.io', 'www.github.io', 'pages.dev', 'workers.dev', 'r2.dev', 'vercel.app', 'herokuapp.com', 'myshopify.com', 'co.uk', 'www.co.uk',
      'r.appspot.com', 'uc.r.appspot.com', '2.azurestaticapps.net', 'eu-west-2.elasticbeanstalk.com', 'up.railway.app',
    ]) {
      expect(isOwnSiteHost(bare), bare).toBe(false);
    }
    const never = [
      // site builders refused outright (Blogger in every country), and hosts whose pages belong to many people by path
      'rosies.wixsite.com', 'rosies.square.site', 'rosies.weebly.com', 'rosies.wordpress.com', 'rosies.blogspot.com', 'rosies.carrd.co', 'rosies.business.site',
      'rosies.blogspot.co.uk', 'rosies.blogspot.com.au', 'rosies.blogspot.de', 'www.rosies.blogspot.fr',
      'sites.google.com', 'linktr.ee', 'www.facebook.com', 'www.instagram.com', 'wa.me', 'github.com', 'www.google.co.uk',
      // cloud storage: the customer's label sits at no fixed depth, so another bucket would share the "domain"
      'rosies.s3.amazonaws.com', 'rosies.s3-website.eu-west-2.amazonaws.com', 's3.amazonaws.com', 'storage.googleapis.com', 'rosies.blob.core.windows.net',
      'rosies.z33.web.core.windows.net', 'rosies.lon1.digitaloceanspaces.com',
      // tunnels and dynamic DNS
      'a1b2c3.ngrok-free.app', 'rosies.ngrok.io', 'some-words-here.trycloudflare.com', 'rosies.loca.lt', 'rosies.duckdns.org', 'rosies.ddns.net',
    ];
    for (const bad of never) {
      expect(isOwnBusinessHost(bad), bad).toBe(false);
      expect(isOwnSiteHost(bad), bad).toBe(false);
    }
    // a business whose own name merely contains the word is not Blogger
    expect(isOwnBusinessHost('myblogspot.co.uk')).toBe(true);
  });

  it('redirects stay on the same customer of a multi-tenant host', async () => {
    const CODE = 'atlaspad-verify=7KQ2-M9XD';
    const requested: string[] = [];
    const deps: Deps = {
      now: () => 0,
      fetch: async (input: string) => {
        const u = new URL(input);
        requested.push(`${u.hostname}${u.pathname}`);
        if (u.hostname === 'bakery.github.io') return new Response(null, { status: 302, headers: { location: `https://someone-else.github.io${u.pathname}` } });
        if (u.hostname === 'cafe.netlify.app' && u.pathname === '/.well-known/atlaspad.txt') return new Response(null, { status: 301, headers: { location: 'https://www.cafe.netlify.app/.well-known/atlaspad.txt' } });
        return new Response(`${CODE}\n`, { status: 200, headers: { 'content-type': 'text/plain' } });
      },
    };
    expect(safeUrl('https://someone-else.github.io/.well-known/atlaspad.txt', registrableDomain('bakery.github.io'))).toBeNull();
    expect(safeUrl('https://other.uc.r.appspot.com/.well-known/atlaspad.txt', registrableDomain('bakery.uc.r.appspot.com'))).toBeNull();
    expect(safeUrl('https://other-app.2.azurestaticapps.net/', registrableDomain('bakery.2.azurestaticapps.net'))).toBeNull();
    // another customer's site serving the code proves nothing; it is never even fetched
    expect(await findOwnershipProof(deps, 'bakery.github.io', CODE)).toBeNull();
    expect(requested.filter((r) => r.startsWith('someone-else.'))).toEqual([]);
    // a redirect within the same customer's site is followed
    expect(await findOwnershipProof(deps, 'cafe.netlify.app', CODE)).toBe('well-known');
    expect(requested.slice(-2)).toEqual(['cafe.netlify.app/.well-known/atlaspad.txt', 'www.cafe.netlify.app/.well-known/atlaspad.txt']);
  });
});

describe('durable rate counters (D1)', () => {
  it('fixed windows, 429 past the cap, reset in the next window', async () => {
    const db = new FakeD1().asD1();
    const t = Date.UTC(2026, 9, 8, 1);
    for (let i = 1; i <= 3; i++) expect(await cap(db, 'k', 3, DAY, t)).toBe(i);
    await expect(cap(db, 'k', 3, DAY, t)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await cap(db, 'k', 3, DAY, t + DAY)).toBe(1);
  });
});

describe('base64 / base58 helpers', () => {
  it('round-trips and rejects garbage', () => {
    const b = crypto.getRandomValues(new Uint8Array(100));
    expect(fromB64(toB64(b))).toEqual(b);
    expect(() => fromB64('not base64!')).toThrow();
    expect(b58encode(new Uint8Array(32)).length).toBe(32);
  });
});
