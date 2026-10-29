/**
 * The guardian page's script (served by scripts/guardian.mjs; no dependencies, no bundler). The server builds and
 * simulates the transaction; this connects the wallet, refuses unless the connected account is the on-chain guardian
 * and the transaction's fee payer, and asks the wallet to sign and send it. The helpers are exported for
 * scripts/test/guardian.test.mjs; the page wiring runs only in a browser.
 */
import { b58decode, b58encode } from '../lib/b58.mjs';

const CONNECT = 'standard:connect';
const SIGN_AND_SEND = 'solana:signAndSendTransaction';

/**
 * The Wallet Standard app side (what @wallet-standard/app does): wallets injected before or after this page register
 * through these two window events. Returns a function that lists the registered wallets.
 */
export function walletRegistry(win) {
  const wallets = new Set();
  const register = (...ws) => {
    for (const w of ws) wallets.add(w);
    return () => ws.forEach((w) => wallets.delete(w));
  };
  const api = Object.freeze({ register });
  win.addEventListener('wallet-standard:register-wallet', (e) => {
    try {
      e.detail(api);
    } catch {
      /* a broken wallet must not break the page */
    }
  });
  win.dispatchEvent(new win.CustomEvent('wallet-standard:app-ready', { detail: api }));
  return () => [...wallets];
}

/**
 * The wallet to use: a Wallet Standard Phantom that can sign and send; else the injected window.phantom.solana; else any
 * other Solana wallet that can (the guardian check decides). Returns { kind, name, wallet | provider } or null.
 */
export function pickWallet(wallets, win) {
  const usable = wallets.filter((w) => w?.features?.[CONNECT] && w.features[SIGN_AND_SEND] && (w.chains ?? []).some((c) => c.startsWith('solana:')));
  const phantom = usable.find((w) => /phantom/i.test(w.name));
  if (phantom) return { kind: 'standard', name: phantom.name, wallet: phantom };
  const legacy = win?.phantom?.solana;
  if (legacy?.isPhantom && typeof legacy.connect === 'function' && typeof legacy.request === 'function') return { kind: 'legacy', name: 'Phantom', provider: legacy };
  return usable[0] ? { kind: 'standard', name: usable[0].name, wallet: usable[0] } : null;
}

/** Connect and return { address, account? } (account: the Wallet Standard account object to sign with). */
export async function connectWallet(choice) {
  if (choice.kind === 'standard') {
    const { accounts } = await choice.wallet.features[CONNECT].connect();
    const account = accounts.find((a) => (a.chains ?? []).some((c) => c.startsWith('solana:'))) ?? accounts[0];
    if (!account) throw new Error(`${choice.name} shared no account`);
    return { address: account.address, account };
  }
  const r = await choice.provider.connect();
  const pk = r?.publicKey ?? choice.provider.publicKey;
  if (!pk) throw new Error('Phantom shared no account');
  return { address: pk.toString() };
}

export function fromBase64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** The fee payer of a serialized legacy transaction: the first account key of its message. */
export function feePayerOf(transaction) {
  const sigs = transaction[0];
  if (sigs >= 0x80) throw new Error('unexpected transaction layout');
  const message = transaction.subarray(1 + 64 * sigs);
  if (message[3] >= 0x80) throw new Error('unexpected message layout'); // compact-u16 key count, one byte below 128
  return b58encode(message.subarray(4, 36));
}

/**
 * Refuses unless the connected wallet is the on-chain guardian and the transaction's fee payer (the server built it
 * for that account). Returns the problem or null.
 */
export function signingProblem({ connected, guardian, transaction }) {
  if (!connected) return 'connect Phantom first';
  if (connected !== guardian) return `${connected} is not the guardian ${guardian}: switch to the guardian account in Phantom and connect again`;
  if (feePayerOf(transaction) !== guardian) return 'the transaction is not for the guardian: reload the page';
  return null;
}

/** Ask the wallet to sign and send; returns the base58 signature. `chain` is solana:mainnet | solana:devnet. */
export async function signAndSend(choice, { account, chain, transaction, message }) {
  if (choice.kind === 'standard') {
    const [out] = await choice.wallet.features[SIGN_AND_SEND].signAndSendTransaction({ account, chain, transaction });
    return b58encode(out.signature);
  }
  // Phantom's injected provider: the documented request form takes the base58 message of a legacy transaction
  const r = await choice.provider.request({ method: 'signAndSendTransaction', params: { message } });
  b58decode(r.signature); // throws on anything but base58
  return r.signature;
}

/* ------------------------------------------------------------------ page wiring (browser only) */

function init() {
  const $ = (id) => document.getElementById(id);
  const listWallets = walletRegistry(window);
  const state = { info: null, choice: null, connected: null, account: null };

  const api = async (path, body) => {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
    return j;
  };
  const lines = (el, items, cls = '') => {
    el.replaceChildren(
      ...items.map((t) => {
        const p = document.createElement('p');
        p.textContent = t;
        if (cls) p.className = cls;
        return p;
      }),
    );
  };
  const action = () => document.querySelector('input[name=action]:checked').value;
  const request = () => ({ action: action(), placeId: $('placeId').value.trim(), wallet: state.connected });

  const showWho = () => {
    if (!state.connected) return lines($('who'), []);
    const isGuardian = state.connected === state.info.guardian;
    lines($('who'), [`${state.choice.name}: ${state.connected}`, isGuardian ? '✓ this is the guardian' : '✗ NOT the guardian: switch account in Phantom, then connect again'], isGuardian ? 'good' : 'bad');
  };

  async function load() {
    try {
      state.info = await api('/api/info');
    } catch (e) {
      return lines($('top'), [`Cannot read the chain: ${e.message}. Reload to try again.`], 'bad');
    }
    const { info } = state;
    $('cluster').textContent = info.cluster.toUpperCase();
    $('cluster').className = `badge ${info.cluster}`;
    $('guardian').textContent = info.guardian;
    // the guardian pays each transaction's fee (5,000 lamports)
    $('balance').textContent = `Guardian balance: ${info.guardianSol} SOL${info.guardianSol < 0.001 ? ' (too little for the fee: send it 0.01 SOL first)' : ''}`;
    $('balance').className = info.guardianSol < 0.001 ? 'bad' : 'muted';
    $('paused').textContent = info.paused ? 'PAUSED' : 'running';
    if (info.prefill?.action) document.querySelector(`input[name=action][value=${info.prefill.action}]`).checked = true;
    if (info.prefill?.placeId) $('placeId').value = info.prefill.placeId;
  }

  $('connect').onclick = async () => {
    state.choice = pickWallet(listWallets(), window);
    if (!state.choice) return lines($('who'), ['No Phantom here. On the phone: open this page in Phantom → Browser. On the laptop: install the Phantom extension and import the guardian account.'], 'bad');
    try {
      const c = await connectWallet(state.choice);
      state.connected = c.address;
      state.account = c.account ?? null;
      showWho();
    } catch (e) {
      lines($('who'), [`${state.choice.name}: ${e.message ?? 'connection refused'}`], 'bad');
    }
  };

  $('review').onclick = async () => {
    $('send').disabled = true;
    lines($('summary'), ['Checking on chain…']);
    try {
      const p = await api('/api/prepare', request());
      lines($('summary'), [...(p.summary ?? []), ...(p.ok ? ['✓ simulated OK: ready to sign'] : (p.problems ?? []).map((x) => `✗ ${x}`)), ...(p.logs ?? [])], p.ok ? 'good' : '');
      $('send').disabled = !p.ok;
    } catch (e) {
      lines($('summary'), [`✗ ${e.message}`], 'bad');
    }
  };

  $('send').onclick = async () => {
    $('send').disabled = true;
    try {
      lines($('result'), ['Building a fresh transaction…']);
      const p = await api('/api/prepare', request()); // fresh blockhash and simulation right before signing
      if (!p.ok) throw new Error((p.problems ?? ['refused']).join('; '));
      const transaction = fromBase64(p.transaction);
      const problem = signingProblem({ connected: state.connected, guardian: p.guardian, transaction });
      if (problem) throw new Error(problem);
      lines($('result'), [`Approve it in ${state.choice.name} within about a minute…`]);
      const sig = await signAndSend(state.choice, { account: state.account, chain: state.info.chain, transaction, message: p.message });
      const link = document.createElement('a');
      link.href = state.info.explorerTx.replace('{sig}', sig);
      link.textContent = sig;
      link.target = '_blank';
      link.rel = 'noreferrer';
      const status = document.createElement('p');
      status.textContent = 'sent: waiting for confirmation…';
      $('result').replaceChildren(link, status);
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await api(`/api/status?sig=${encodeURIComponent(sig)}`).catch(() => null);
        if (s?.status === 'failed') {
          status.textContent = `✗ failed on chain: ${JSON.stringify(s.err)}`;
          status.className = 'bad';
          return;
        }
        if (s?.status === 'confirmed' || s?.status === 'finalized') {
          status.textContent = `✓ ${s.status}. Done: check the explorer link, then run the watchdog.`;
          status.className = 'good';
          await load();
          return;
        }
      }
      status.textContent = 'not confirmed after 90 s: open the explorer link; if it is not there, press Review and try again';
    } catch (e) {
      lines($('result'), [`✗ ${e.message ?? 'refused'}`], 'bad');
      $('send').disabled = false; // after a send, Review again first
    }
  };

  load();
}

if (typeof document !== 'undefined') init();
