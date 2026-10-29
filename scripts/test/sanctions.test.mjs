// node --test scripts/test/   Sanctions tooling: the OFAC SDN parser of update-sanctions.mjs, the committed list, and the
// wrangler routing the geo-block relies on (no network).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isAddress } from '../lib/b58.mjs';
import { readWranglerConfig } from '../lib/wrangler.mjs';
import { LIST_PATH, listFile, solAddressesFromSdn, updateProblems } from '../update-sanctions.mjs';

const SOL_A = '42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi';
const SOL_B = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
const SOL_C = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';

/** A minimal document in the sdn_advanced.xml shape (namespaces and most of the schema left out). */
const SDN = `<?xml version="1.0" encoding="utf-8"?>
<Sanctions Version="3" xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML">
  <DateOfIssue CalendarTypeID="1">
    <Year>2026</Year>
    <Month>10</Month>
    <Day>2</Day>
  </DateOfIssue>
  <ReferenceValueSets>
    <FeatureTypeValues>
      <FeatureType ID="345" FeatureTypeGroupID="1">Digital Currency Address - ETH</FeatureType>
      <FeatureType ID="887" FeatureTypeGroupID="1">Digital Currency Address - USDT</FeatureType>
      <FeatureType ID="998" FeatureTypeGroupID="1">Digital Currency Address - USDC</FeatureType>
      <FeatureType ID="1167" FeatureTypeGroupID="1">Digital Currency Address - SOL</FeatureType>
    </FeatureTypeValues>
  </ReferenceValueSets>
  <DistinctParties>
    <DistinctParty FixedRef="1"><Profile ID="1">
      <Feature ID="10" FeatureTypeID="1167">
        <FeatureVersion ID="11" ReliabilityID="1"><Comment /><VersionDetail DetailTypeID="1432">${SOL_B}</VersionDetail></FeatureVersion>
        <FeatureVersion ID="12" ReliabilityID="1"><VersionDetail DetailTypeID="1432"> ${SOL_A} </VersionDetail></FeatureVersion>
        <IdentityReference IdentityID="1" IdentityFeatureLinkTypeID="1" />
      </Feature>
      <Feature ID="13" FeatureTypeID="1167">
        <FeatureVersion ID="14" ReliabilityID="1"><VersionDetail DetailTypeID="1432">not-an-address</VersionDetail></FeatureVersion>
      </Feature>
      <Feature ID="15" FeatureTypeID="345">
        <FeatureVersion ID="16" ReliabilityID="1"><VersionDetail DetailTypeID="1432">0x8589427373D6D84E98730D7795D8f6f8731FDA16</VersionDetail></FeatureVersion>
      </Feature>
    </Profile></DistinctParty>
    <DistinctParty FixedRef="2"><Profile ID="2">
      <Feature ID="20" FeatureTypeID="887">
        <FeatureVersion ID="21" ReliabilityID="1"><VersionDetail DetailTypeID="1432">TNiqvU8w4sgSQnWuuyZ4M7y4jUbTZKd5Fu</VersionDetail></FeatureVersion>
      </Feature>
      <Feature ID="22" FeatureTypeID="998">
        <FeatureVersion ID="23" ReliabilityID="1"><VersionDetail DetailTypeID="1432">${SOL_C}</VersionDetail></FeatureVersion>
      </Feature>
      <Feature ID="24" FeatureTypeID="1167">
        <FeatureVersion ID="25" ReliabilityID="1"><VersionDetail DetailTypeID="1432">${SOL_A}</VersionDetail></FeatureVersion>
      </Feature>
    </Profile></DistinctParty>
  </DistinctParties>
</Sanctions>`;

test('update-sanctions: SOL features (+ Solana-format USDC/USDT), sorted, de-duplicated; typos reported', () => {
  const r = solAddressesFromSdn(SDN);
  assert.deepEqual(r.addresses, [SOL_A, SOL_B, SOL_C].sort());
  assert.deepEqual(r.rejected, ['not-an-address']);
  assert.equal(r.listDate, '2026-10-02');
  assert.equal(r.solType, true);
  // the Tron USDT and the ETH address are not Solana wallets
  assert.ok(!r.addresses.some((a) => a.startsWith('T') || a.startsWith('0x')));
});

test('update-sanctions: refuses a document without SOL features or a list that shrank by half', () => {
  assert.deepEqual(updateProblems(solAddressesFromSdn(SDN), { addresses: [SOL_A, SOL_B] }), []);
  const empty = solAddressesFromSdn('<Sanctions><DateOfIssue><Year>2026</Year><Month>1</Month><Day>1</Day></DateOfIssue></Sanctions>');
  assert.deepEqual(empty.addresses, []);
  assert.ok(updateProblems(empty, null).some((p) => /no "Digital Currency Address - SOL"/.test(p)));
  const shrunk = { addresses: [SOL_A], listDate: '2026-10-02', solType: true };
  assert.ok(updateProblems(shrunk, { addresses: [SOL_A, SOL_B, SOL_C] }).some((p) => /truncated/.test(p)));
  assert.deepEqual(updateProblems(shrunk, { addresses: [SOL_A, SOL_B] }), []);
});

test('the committed list has the generated shape and only valid, sorted, unique Solana addresses', () => {
  const list = JSON.parse(readFileSync(LIST_PATH, 'utf8'));
  assert.deepEqual(Object.keys(list), Object.keys(listFile({ addresses: [], listDate: null })));
  assert.match(list.url, /^https:\/\/sanctionslistservice\.ofac\.treas\.gov\//);
  assert.ok(list.addresses.every(isAddress));
  assert.deepEqual([...new Set(list.addresses)].sort(), list.addresses);
});

test('geo-block routing: devnet and mainnet run the Worker first on every page, never on static files', () => {
  const cfg = readWranglerConfig();
  for (const env of ['devnet', 'mainnet']) {
    const rules = cfg.env[env].assets.run_worker_first;
    assert.ok(rules.includes('/*'), `${env}: /* runs the Worker first`);
    for (const r of ['!/assets/*', '!/terms', '!/terms.html', '!/privacy', '!/privacy.html', '!/favicon.svg']) assert.ok(rules.includes(r), `${env}: ${r}`);
    // exclusions are exact files: a wildcard such as '!/terms*' would let a blocked visitor load the app shell from
    // /terms-anything (the SPA fallback) without the Worker seeing the request; /assets/* is the one hashed-bundle folder
    for (const r of rules.filter((x) => x.startsWith('!') && x.includes('*'))) assert.equal(r, '!/assets/*', `${env}: ${r}`);
    // wrangler's own rules: '/' or '!/' prefix, no duplicates, no rule made redundant by a wildcard in the same group
    for (const r of rules) assert.ok(r.startsWith('/') || r.startsWith('!/'), `${env}: ${r}`);
    assert.equal(new Set(rules).size, rules.length);
    for (const group of [rules.filter((r) => !r.startsWith('!')), rules.filter((r) => r.startsWith('!'))]) {
      for (const w of group.filter((r) => r.endsWith('*'))) {
        for (const o of group) assert.ok(o === w || !o.startsWith(w.slice(0, -1)), `${env}: ${o} is redundant next to ${w}`);
      }
    }
  }
});
