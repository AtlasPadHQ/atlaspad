#!/usr/bin/env node
/**
 * initialize_config for the shop-vault program (SPEC §5.0, §11 step 2; INTEGRATION §10.2).
 *
 *   node scripts/init-config.mjs --cluster devnet [--window 60] [--execute]
 *
 * - Dry run by default: checks the program, the upgrade authority and the keys, then SIMULATES initialize_config and
 *   checks the build marker in the simulated logs. `--execute` sends it (devnet only from this CLI).
 * - Idempotent: when Config already exists it is decoded and verified (flavor, keys, window, rotation delay) and
 *   nothing is sent.
 * - Devnet keys: attestor = .keys/devnet-attestor.json, guardian = .keys/devnet-guardian.json,
 *   governance = upgrade authority = payer = .keys/devnet-deployer.json (as in the program's e2e).
 * - Mainnet runs only through go-mainnet.mjs, which imports initConfig() with allowMainnet.
 * Writes the public result to deploy/<cluster>.json. Prints pubkeys only.
 */
import { writeDeploy } from './lib/deployJson.mjs';
import { keypair, pubkey } from './lib/keys.mjs';
import { bad, fatal, head, info, ok, parseArgs, warn } from './lib/log.mjs';
import { CONFIG_PDA, explorerTx, GENESIS, PROGRAM_ID } from './lib/paths.mjs';
import { deployedProgram } from './lib/program.mjs';
import { assertGenesis, getAccount, label, pickRpc } from './lib/rpc.mjs';

/** Expected build constants per flavour (SPEC §2). */
export const FLAVOR_RULES = {
  devnet: { minWindow: 60, maxWindow: 86_400, rotationDelay: 300, marker: 'shop-vault-build:devnet' },
  mainnet: { minWindow: 259_200, maxWindow: 2_592_000, rotationDelay: 604_800, marker: 'shop-vault-build:mainnet' },
};

/** Problems with the three Config keys (SPEC I10) and the window, as strings (empty = ok). */
export function configInputProblems({ cluster, attestor, governance, guardian, windowSecs }) {
  const p = [];
  const rules = FLAVOR_RULES[cluster];
  const keys = { attestor, governance, guardian };
  for (const [k, v] of Object.entries(keys)) if (!v || v === '11111111111111111111111111111111') p.push(`${k} is missing or zero`);
  if (new Set(Object.values(keys)).size !== 3) p.push('attestor, governance and guardian must be three different keys (SPEC I10)');
  if (!Number.isSafeInteger(windowSecs) || windowSecs < rules.minWindow || windowSecs > rules.maxWindow) {
    p.push(`claim window ${windowSecs} s is outside the ${cluster} build's [${rules.minWindow}, ${rules.maxWindow}]`);
  }
  return p;
}

/** Compare a decoded Config with what we expect. Returns problem strings. */
export function configStateProblems(cfg, { cluster, attestor, governance, guardian, windowSecs }) {
  const p = [];
  if (cfg.flavor !== cluster) p.push(`Config.flavor is ${cfg.flavor}, expected ${cluster} (wrong binary initialised it)`);
  if (attestor && cfg.attestor.toBase58() !== attestor) p.push(`Config.attestor is ${cfg.attestor.toBase58()}, expected ${attestor}`);
  if (governance && cfg.governance.toBase58() !== governance) p.push(`Config.governance is ${cfg.governance.toBase58()}, expected ${governance}`);
  if (guardian && cfg.guardian.toBase58() !== guardian) p.push(`Config.guardian is ${cfg.guardian.toBase58()}, expected ${guardian}`);
  if (windowSecs && cfg.claimWindowSecs !== BigInt(windowSecs)) p.push(`Config.claim_window_secs is ${cfg.claimWindowSecs}, expected ${windowSecs}`);
  if (cfg.rotationDelaySecs !== BigInt(FLAVOR_RULES[cluster].rotationDelay)) p.push(`Config.rotation_delay_secs is ${cfg.rotationDelaySecs}, expected ${FLAVOR_RULES[cluster].rotationDelay}`);
  return p;
}

/**
 * @param {{ cluster: 'devnet'|'mainnet', url: string, payer: any, attestor: string, governance: string,
 *           guardian: string, windowSecs: number, execute: boolean, allowMainnet?: boolean }} o
 * @returns {Promise<{ status: 'exists'|'initialized'|'simulated', problems: string[], signature?: string }>}
 */
export async function initConfig(o) {
  const { cluster, url, payer, attestor, governance, guardian, windowSecs, execute } = o;
  if (cluster === 'mainnet' && execute && !o.allowMainnet) throw new Error('mainnet initialize_config runs only from go-mainnet.mjs');
  await assertGenesis(url, cluster);
  const { web3, sv, connection, buildTx, simulateAndSend, programEvents } = await import('./lib/web3.mjs');

  const inputProblems = configInputProblems({ cluster, attestor, governance, guardian, windowSecs });
  if (inputProblems.length) return { status: 'invalid', problems: inputProblems };

  const prog = await deployedProgram(url);
  if (!prog.exists || !prog.executable) return { status: 'no-program', problems: [`program ${PROGRAM_ID} is not deployed on ${cluster}`] };
  const payerPk = payer.publicKey.toBase58();
  if (prog.upgradeAuthority !== payerPk) {
    return { status: 'not-authority', problems: [`upgrade authority is ${prog.upgradeAuthority ?? 'none (immutable)'}, not the payer ${payerPk}; initialize_config would fail with NotUpgradeAuthority`] };
  }

  const existing = await getAccount(url, CONFIG_PDA);
  if (existing) {
    const cfg = sv.decodeConfig(existing.data);
    const problems = configStateProblems(cfg, { cluster, attestor, governance, guardian, windowSecs });
    writeDeploy(cluster, {
      genesisHash: GENESIS[cluster],
      programId: PROGRAM_ID,
      configPda: CONFIG_PDA,
      attestor: cfg.attestor.toBase58(),
      guardian: cfg.guardian.toBase58(),
      governance: cfg.governance.toBase58(),
      upgradeAuthority: prog.upgradeAuthority,
      claimWindowSecs: Number(cfg.claimWindowSecs),
      rotationDelaySecs: Number(cfg.rotationDelaySecs),
      flavor: cfg.flavor,
    });
    return { status: 'exists', problems, config: cfg };
  }

  const ix = sv.initializeConfig({
    payer: payer.publicKey,
    attestor: new web3.PublicKey(attestor),
    governance: new web3.PublicKey(governance),
    guardian: new web3.PublicKey(guardian),
    claimWindowSecs: windowSecs,
  });
  const conn = connection(url);
  const built = await buildTx(conn, payer.publicKey, [ix], [payer]);
  const r = await simulateAndSend(conn, built, { execute, label: 'initialize_config' });
  const ev = programEvents(r.logs).find((e) => e.name === 'ConfigInitialized');
  const marker = FLAVOR_RULES[cluster].marker;
  const problems = [];
  if (!ev || !ev.fields.some((f) => f.toString('latin1') === marker)) problems.push(`ConfigInitialized does not carry ${marker} (wrong binary deployed?)`);
  if (r.simulatedOnly) return { status: 'simulated', problems, unitsConsumed: r.unitsConsumed };

  const after = await getAccount(url, CONFIG_PDA);
  const cfg = sv.decodeConfig(after.data);
  problems.push(...configStateProblems(cfg, { cluster, attestor, governance, guardian, windowSecs }));
  writeDeploy(cluster, {
    genesisHash: GENESIS[cluster],
    programId: PROGRAM_ID,
    configPda: CONFIG_PDA,
    attestor,
    guardian,
    governance,
    upgradeAuthority: prog.upgradeAuthority,
    claimWindowSecs: Number(cfg.claimWindowSecs),
    rotationDelaySecs: Number(cfg.rotationDelaySecs),
    flavor: cfg.flavor,
    configInitializedAt: new Date().toISOString(),
    configInitSignature: r.signature,
  });
  return { status: 'initialized', problems, signature: r.signature, config: cfg };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['execute']);
  const cluster = args.cluster ?? 'devnet';
  if (cluster !== 'devnet') fatal('this CLI initialises DEVNET only; mainnet runs through scripts/go-mainnet.mjs (H1)', 64);
  const windowSecs = Number(args.window ?? 60);
  const { url, fallback } = await pickRpc(cluster);
  head(`init-config · ${cluster} · ${label(url)} · ${args.execute ? 'EXECUTE' : 'dry run'}`);
  if (fallback) info(fallback);
  const payer = await keypair('devnet-deployer');
  const o = {
    cluster,
    url,
    payer,
    attestor: pubkey('devnet-attestor'),
    guardian: pubkey('devnet-guardian'),
    governance: payer.publicKey.toBase58(),
    windowSecs,
    execute: !!args.execute,
  };
  info(`attestor ${o.attestor} · guardian ${o.guardian} · governance (deployer) ${o.governance} · window ${windowSecs} s`);
  const r = await initConfig(o);
  for (const p of r.problems) bad(p);
  if (r.status === 'exists') (r.problems.length ? warn : ok)(`Config ${CONFIG_PDA} already exists${r.problems.length ? ' with differences (above)' : ' and matches'}`);
  else if (r.status === 'simulated') (r.problems.length ? bad : ok)(`initialize_config simulated OK (${r.unitsConsumed} CU); dry run, add --execute to send`);
  else if (r.status === 'initialized') ok(`Config initialised — ${explorerTx(r.signature, cluster)}`);
  else bad(`cannot initialise: ${r.status}`);
  process.exit(r.problems.length || !['exists', 'simulated', 'initialized'].includes(r.status) ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
