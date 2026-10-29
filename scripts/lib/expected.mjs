/**
 * Expected authority state for scripts/watchdog.mjs (SPEC §8.6, §11), derived from deploy/<cluster>.json (public
 * addresses only). The planned go-mainnet handover is expected: governance moves from the deployer to Squads vault A
 * (`squadsAVault`) and the program upgrade authority from the deployer to Squads vault B (`squadsBVault`), and the
 * pending `propose_governance(Squads vault A)` in between is planned too. Both the before and after values pass (the
 * before value with a "not yet handed over" warning on mainnet). Any other attestor, guardian, governance or upgrade
 * authority is CRITICAL: nobody planned it.
 *
 * Findings are plain objects `{ status: 'ok'|'warn'|'fail', what, detail }`; a `fail` whose `what` starts with
 * CRITICAL makes the watchdog exit 2 (its GitHub Actions run fails, which GitHub emails; and it posts to
 * ALERT_WEBHOOK_URL when that is set).
 */

const uniq = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x.length > 0))];

/** The expected values per role (lists: any listed value is planned). */
export function expectedState(dep = {}) {
  return {
    attestor: uniq([dep.attestor]),
    guardian: uniq([dep.guardian]),
    governance: uniq([dep.governance, dep.squadsAVault]),
    upgradeAuthority: uniq([dep.upgradeAuthority, dep.squadsBVault]),
    /** Pending governance proposals that are planned without a D1 admin_expectations row (the Squads A handover). */
    pendingGovernance: uniq([dep.squadsAVault]),
    handover: { governance: dep.squadsAVault ?? null, upgradeAuthority: dep.squadsBVault ?? null },
    /** The program was deployed by our scripts (a missing program is then CRITICAL, not "not deployed yet"). */
    deployed: typeof dep.programDataSha256 === 'string' && dep.programDataSha256.length > 0,
  };
}

/**
 * Config keys and the upgrade authority vs the expected state.
 * @param {{ cluster: string, config: { attestor: string, guardian: string, governance: string },
 *   program: { exists: boolean, upgradeAuthority?: string|null }, expected: ReturnType<typeof expectedState> }} o
 * @returns {{ role: 'attestor'|'guardian'|'governance'|'upgradeAuthority', status: 'ok'|'warn'|'fail', what: string, detail?: string }[]}
 */
export function assessAuthorities({ cluster, config, program, expected }) {
  const out = [];
  const src = `deploy/${cluster}.json`;
  for (const k of ['attestor', 'guardian']) {
    const want = expected[k];
    if (!want.length) out.push({ role: k, status: 'warn', what: `Config.${k}`, detail: `${config[k]} (not recorded in ${src})` });
    else if (want.includes(config[k])) out.push({ role: k, status: 'ok', what: `Config.${k} = ${src}`, detail: config[k] });
    else out.push({ role: k, status: 'fail', what: `CRITICAL Config.${k} changed`, detail: `${config[k]} ≠ ${src} ${want.join(' / ')} (a planned rotation updates ${src}; otherwise RUNBOOK "Compromised attestor")` });
  }

  const gov = config.governance;
  const handoverGov = expected.handover.governance;
  if (!expected.governance.length) out.push({ role: 'governance', status: 'warn', what: 'Config.governance', detail: `${gov} (not recorded in ${src})` });
  else if (!expected.governance.includes(gov)) out.push({ role: 'governance', status: 'fail', what: 'CRITICAL Config.governance changed', detail: `${gov} is neither ${src} governance nor Squads vault A (${expected.governance.join(' / ')})` });
  else if (cluster === 'mainnet' && handoverGov && gov !== handoverGov) out.push({ role: 'governance', status: 'warn', what: 'governance not yet Squads vault A', detail: `${gov} (SPEC §11 step 3: planned handover to ${handoverGov})` });
  else out.push({ role: 'governance', status: 'ok', what: 'Config.governance', detail: gov === handoverGov ? `${gov} (Squads vault A)` : gov });

  if (!program.exists) out.push(expected.deployed ? { role: 'upgradeAuthority', status: 'fail', what: 'CRITICAL program missing', detail: `${src} records a deployed program; the program account is gone` } : { role: 'upgradeAuthority', status: 'fail', what: 'program', detail: 'not deployed' });
  else if (!program.upgradeAuthority) out.push({ role: 'upgradeAuthority', status: 'ok', what: 'program is immutable (--final)' });
  else {
    const ua = program.upgradeAuthority;
    const handoverUa = expected.handover.upgradeAuthority;
    if (!expected.upgradeAuthority.length) out.push({ role: 'upgradeAuthority', status: 'ok', what: 'upgrade authority', detail: `${ua} (not recorded in ${src})` });
    else if (!expected.upgradeAuthority.includes(ua)) out.push({ role: 'upgradeAuthority', status: 'fail', what: 'CRITICAL upgrade authority changed', detail: `${ua} is neither ${src} upgradeAuthority nor Squads vault B (${expected.upgradeAuthority.join(' / ')})` });
    else if (cluster === 'mainnet' && handoverUa && ua !== handoverUa) out.push({ role: 'upgradeAuthority', status: 'warn', what: 'upgrade authority not yet Squads vault B', detail: `${ua} (SPEC §11 step 4: planned handover to ${handoverUa})` });
    else out.push({ role: 'upgradeAuthority', status: 'ok', what: 'upgrade authority', detail: ua === handoverUa ? `${ua} (Squads vault B)` : ua });
  }
  return out;
}

/**
 * One pending proposal (watchdog `pendingProposals()` item) vs the expected state and the D1 registrations.
 * The governance handover to Squads vault A (proposed by governance, not the guardian) is planned even without D1.
 */
export function assessProposal(p, { expected, registered }) {
  if (p.kind === 4 && !p.byGuardian && expected.pendingGovernance.includes(p.key)) return { status: 'warn', planned: true };
  if (registered) return { status: 'warn', planned: true };
  return { status: 'fail', planned: false };
}

/** Exit code of a watchdog run: 2 when any CRITICAL failure, 1 for other failures or warnings, else 0. */
export function exitCodeOf(items) {
  if (items.some((i) => i.status === 'fail' && /CRITICAL/.test(i.what))) return 2;
  return items.some((i) => i.status === 'fail' || i.status === 'warn') ? 1 : 0;
}

/** The CRITICAL failures of a run (for the webhook). */
export function criticalFindings(items) {
  return items.filter((i) => i.status === 'fail' && /CRITICAL/.test(i.what)).map(({ what, detail }) => ({ what, detail }));
}
