/** Wire DTO fixtures for the real-data tests (not shipped: only *.test.ts import it). */
import type { CoinDTO, MarketDTO } from '../../worker/wire';

export function market(over: Partial<MarketDTO> = {}): MarketDTO {
  return {
    venue: 'curve',
    priceLamports: 28, // 28 lamports per whole token
    mcapLamports: '28000000000',
    vSol: '30000000000',
    vTok: '1073000000000000',
    realSol: '0',
    realTok: '793100000000000',
    supply: '1000000000000000',
    progressPct: 0,
    complete: false,
    vol24hLamports: '0',
    change24hPct: null,
    lastTradeAt: null,
    slot: 1,
    at: 1_000,
    ...over,
  };
}

export function coinDto(over: Partial<CoinDTO> = {}): CoinDTO {
  return {
    placeId: 'ChIJtestplace0001',
    placeHash: 'ab'.repeat(32),
    mint: 'Mint1111111111111111111111111111111111111',
    vault: 'Vau1t111111111111111111111111111111111111',
    vaultState: 'State11111111111111111111111111111111111',
    bondingCurve: 'Curve11111111111111111111111111111111111',
    ticker: 'KEBAB',
    name: 'Kebab King',
    description: '',
    category: 'kebab',
    emoji: '🥙',
    bg: '#ffe4cc',
    imageUrl: 'https://cornershop-devnet.tiejiucai.workers.dev/img/0123456789abcdef0123456789abcdef.webp',
    metadataUri: 'https://cornershop-devnet.tiejiucai.workers.dev/meta/0123456789abcdef0123456789abcdef.json',
    launcher: 'Launcher11111111111111111111111111111111',
    createdAt: 500,
    launchSig: 'sig1',
    location: { lat: 51.5469, lng: -0.0712 },
    graduated: false,
    pool: null,
    market: market(),
    fees: {
      earnedLamports: '1234567890',
      waitingLamports: '1234567890',
      withdrawableNowLamports: '1000000000',
      collectableLamports: '234567890',
      withdrawnLamports: '0',
      at: 1_000,
    },
    owner: { status: 'unclaimed', owner: null, pendingOwner: null, unlockTs: null, inProbation: false, ownerSince: null },
    holders: null,
    holdersAt: null,
    ...over,
  };
}

