import { describe, expect, it } from 'vitest';
import {
  extractFirstUrl,
  ftidToPlaceId,
  isAllowedMapsHost,
  linkHostLabel,
  looksLikeMapsLink,
  parseMapsLink,
} from './parseMapsLink';

// URL shapes as Google served them in 2025–26. The places are Google's own documentation samples (Googleplex, Google
// Sydney, Lumen Field) or fictional ones: no real business is named here.
const GOOGLEPLEX =
  'https://www.google.com/maps/place/Googleplex/@37.4220041,-122.0862515,17z/data=!3m1!4b1!4m6!3m5!1s0x808fba02425dad8f:0x6c296c66619367e0!8m2!3d37.4219998!4d-122.0840575!16s%2Fg%2F11c8b0ssp6';
const MOBILE_PLACE =
  'https://www.google.com/maps/place/Nowhere+-+Coffee+%26+Cake,+Strada+Exemplu+1+Bucure%C8%99ti/data=!4m6!3m5!1s0x40b1000000000c01:0x00000000000000d2!8m2!3d44.4312345!4d26.1012345!16s%2Fg%2F11f1ct10na1';
const APP_SHARE =
  'https://maps.google.com?q=9C3X+QXH+Nowhere+Greens+cafe,+1+Example+Road,+Sometown&ftid=0x48760000000000a1:0x00000000000000b2&entry=gps&lucs=,94233200&g_ep=CAISDTYu&g_st=ic';
const CONSENT =
  'https://consent.google.com/m?continue=https://www.google.com/maps/search/?api%3D1%26query%3DLumen%2BField%26query_place_id%3DChIJKxjxuaNqkFQR3CK6O1HNNqY&gl=GB&m=1&pc=m&uxe=eomtm&cm=2&hl=en&src=1';

describe('ftidToPlaceId', () => {
  it('matches Google’s own Googleplex example', () => {
    expect(ftidToPlaceId('0x808fba02425dad8f', '0x6c296c66619367e0')).toBe('ChIJj61dQgK6j4AR4GeTYWZsKWw');
  });
  it('matches Google’s own Google Sydney example (its documented place id; the low half is its documented cid)', () => {
    expect(ftidToPlaceId('0x6b12ae37b47f5b37', '0x8eaddfcd1b32ca52')).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(BigInt('0x8eaddfcd1b32ca52').toString()).toBe('10281119596374313554');
  });
  it('encodes a short ftid half (fictional place used below)', () => {
    expect(ftidToPlaceId('0x48760000000000a1', '0x00000000000000b2')).toBe('ChIJoQAAAAAAdkgRsgAAAAAAAAA');
  });
});

describe('parseMapsLink — places', () => {
  it('#1 desktop place URL: ftid candidate, exact pin, zoom, name, cid', () => {
    const p = parseMapsLink(GOOGLEPLEX);
    expect(p?.kind).toBe('place');
    expect(p?.candidatePlaceId).toBe('ChIJj61dQgK6j4AR4GeTYWZsKWw');
    expect(p?.ftid).toEqual({ hi: '0x808fba02425dad8f', lo: '0x6c296c66619367e0' });
    expect(p?.cid).toBe(BigInt('0x6c296c66619367e0').toString());
    expect(p?.location).toEqual({ lat: 37.4219998, lng: -122.0840575 }); // pin, not the @ viewport centre
    expect(p?.zoom).toBe(17);
    expect(p?.name).toBe('Googleplex');
    expect(p?.placeId).toBeUndefined();
  });

  it('#2 place URL without @ (mobile web)', () => {
    const p = parseMapsLink(MOBILE_PLACE);
    expect(p?.kind).toBe('place');
    expect(p?.candidatePlaceId).toBe(ftidToPlaceId('0x40b1000000000c01', '0x00000000000000d2'));
    expect(p?.location).toEqual({ lat: 44.4312345, lng: 26.1012345 });
    expect(p?.name).toBe('Nowhere - Coffee & Cake, Strada Exemplu 1 București');
  });

  it('#3 q=place_id:', () => {
    const p = parseMapsLink('https://www.google.com/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(p?.kind).toBe('place');
    expect(p?.placeId).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('#4 official Maps URLs API: query_place_id + lat,lng query', () => {
    const p = parseMapsLink(
      'https://www.google.com/maps/search/?api=1&query=47.5951518%2C-122.3316393&query_place_id=ChIJKxjxuaNqkFQR3CK6O1HNNqY',
    );
    expect(p?.kind).toBe('place');
    expect(p?.placeId).toBe('ChIJKxjxuaNqkFQR3CK6O1HNNqY');
    expect(p?.location).toEqual({ lat: 47.5951518, lng: -122.3316393 });
    expect(p?.query).toBeUndefined();
  });

  it('data !19sChIJ… place id', () => {
    const p = parseMapsLink(
      'https://www.google.com/maps/place/Bosphorus/@51.5,-0.07,17z/data=!4m7!3m6!1s0x0:0x0!8m2!3d51.549!4d-0.075!19sChIJN1t_tDeuEmsRUsoyG83frY4',
    );
    expect(p?.placeId).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(p?.candidatePlaceId).toBeUndefined(); // 0x0 high half is not a real ftid
    expect(p?.location).toEqual({ lat: 51.549, lng: -0.075 });
  });

  it('#5 CID only', () => {
    const p = parseMapsLink('https://maps.google.com/?cid=10281119596374313554');
    expect(p?.kind).toBe('place');
    expect(p?.cid).toBe('10281119596374313554');
    expect(p?.placeId).toBeUndefined();
  });

  it('#6 app share after redirect: ftid + name from q (plus code stripped), no coordinates', () => {
    const p = parseMapsLink(APP_SHARE);
    expect(p?.kind).toBe('place');
    expect(p?.candidatePlaceId).toBe('ChIJoQAAAAAAdkgRsgAAAAAAAAA');
    expect(p?.name).toBe('Nowhere Greens cafe');
    expect(p?.location).toBeUndefined();
  });

  it('#7 search → Maps handoff with ftid', () => {
    const p = parseMapsLink(
      'https://maps.google.com/maps?client=firefox-b-m&sca_esv=1&q=Kebab&ftid=0x1458411f8f55adbb:0xbc693e01227e010d',
    );
    expect(p?.kind).toBe('place');
    expect(p?.candidatePlaceId).toBe(ftidToPlaceId('0x1458411f8f55adbb', '0xbc693e01227e010d'));
  });

  it('#15 Business Profile redirect target: name + ludocid', () => {
    const p = parseMapsLink('https://www.google.com/search?q=Google+Sydney+-+Pirrama+Road&ludocid=10281119596374313554&lsig=AB86z');
    expect(p?.kind).toBe('place');
    expect(p?.cid).toBe('10281119596374313554');
    expect(p?.name).toBe('Google Sydney - Pirrama Road');
  });

  it('cc-TLD hosts', () => {
    expect(parseMapsLink('https://www.google.co.uk/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4')?.placeId).toBe(
      'ChIJN1t_tDeuEmsRUsoyG83frY4',
    );
    expect(parseMapsLink('https://maps.google.de/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4')?.placeId).toBe(
      'ChIJN1t_tDeuEmsRUsoyG83frY4',
    );
    const au = parseMapsLink('https://www.google.com.au/maps/place/Opera+House/@-33.8567844,151.213108,17z');
    expect(au?.kind).toBe('place');
    expect(au?.name).toBe('Opera House');
    expect(au?.location).toEqual({ lat: -33.8567844, lng: 151.213108 });
  });
});

describe('parseMapsLink — short links, wrappers, pasted text', () => {
  it('#8 maps.app.goo.gl short link (iOS ?g_st=ic)', () => {
    const p = parseMapsLink('https://maps.app.goo.gl/ExampleShortLink1?g_st=ic');
    expect(p?.kind).toBe('short');
    expect(p?.host).toBe('maps.app.goo.gl');
  });

  it('#9 Firebase dynamic link is unwrapped locally', () => {
    const inner = encodeURIComponent('https://www.google.com/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4');
    const p = parseMapsLink(`https://maps.app.goo.gl/?link=${inner}&apn=com.google.android.apps.maps&isi=585027354`);
    expect(p?.kind).toBe('place');
    expect(p?.placeId).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
  });

  it('#10 legacy goo.gl/maps and #15 g.page are short (Worker resolves them)', () => {
    expect(parseMapsLink('https://goo.gl/maps/abc123xyz')?.kind).toBe('short');
    expect(parseMapsLink('https://g.page/r/CVLKMhvN362OEAE/')?.kind).toBe('short');
    expect(parseMapsLink('https://goo.gl/abc')).toBeNull(); // not a maps short link
  });

  it('#11 consent interstitial is unwrapped, never followed', () => {
    const p = parseMapsLink(CONSENT);
    expect(p?.kind).toBe('place');
    expect(p?.placeId).toBe('ChIJKxjxuaNqkFQR3CK6O1HNNqY');
    expect(p?.host).toBe('www.google.com');
    expect(p?.name).toBe('Lumen Field');
  });

  it('URL inside Android share text', () => {
    const p = parseMapsLink('Kebab Hut\n1 Nowhere Street, London\nhttps://maps.app.goo.gl/ExampleShortLink1');
    expect(p?.kind).toBe('short');
    expect(p?.url).toBe('https://maps.app.goo.gl/ExampleShortLink1');
  });

  it('strips trailing punctuation and accepts scheme-less links', () => {
    expect(extractFirstUrl('look (https://maps.app.goo.gl/abc).')).toBe('https://maps.app.goo.gl/abc');
    expect(extractFirstUrl('maps.app.goo.gl/abc')).toBe('https://maps.app.goo.gl/abc');
    const p = parseMapsLink('google.com/maps/place/Kebab+Hut/@51.5,-0.1,16z');
    expect(p?.name).toBe('Kebab Hut');
    expect(p?.location).toEqual({ lat: 51.5, lng: -0.1 });
  });
});

describe('parseMapsLink — search, coords, directions, unsupported', () => {
  it('#12 search queries', () => {
    const a = parseMapsLink('https://www.google.com/maps/search/?api=1&query=pizza+seattle+wa');
    expect(a?.kind).toBe('search');
    expect(a?.query).toBe('pizza seattle wa');
    const b = parseMapsLink('https://www.google.com/maps/search/kebab+dalston/@51.546,-0.075,15z');
    expect(b?.kind).toBe('search');
    expect(b?.query).toBe('kebab dalston');
    expect(b?.location).toEqual({ lat: 51.546, lng: -0.075 });
    expect(parseMapsLink('https://maps.google.com/?q=coffee')?.kind).toBe('search');
  });

  it('#13 map view only → coords', () => {
    const p = parseMapsLink('https://www.google.com/maps/@52.5067296,13.2599309,6z');
    expect(p?.kind).toBe('coords');
    expect(p?.location).toEqual({ lat: 52.5067296, lng: 13.2599309 });
    expect(p?.zoom).toBe(6);
    expect(parseMapsLink('https://www.google.com/maps/place/51.5,-0.12')?.kind).toBe('coords');
  });

  it('#14 directions are rejected', () => {
    expect(
      parseMapsLink(
        'https://www.google.com/maps/dir//The+Station,+1+Mends+St,+South+Perth+WA+6151/@-31.96,115.85,14z/data=!4m8!4m7!1m0!1m5!1m1!1s0x2a32a529928d7447%3A0x4a1084749ffdee05',
      )?.kind,
    ).toBe('directions');
    expect(parseMapsLink('https://www.google.com/maps/dir/?api=1&destination=Paris')?.kind).toBe('directions');
    expect(parseMapsLink('https://maps.google.com/maps?saddr=A&daddr=B')?.kind).toBe('directions');
  });

  it('#16 Google share links are recognised but unsupported', () => {
    expect(parseMapsLink('https://share.google/abc123')?.kind).toBe('unsupported');
    expect(parseMapsLink('https://g.co/kgs/abc123')?.kind).toBe('unsupported');
    expect(parseMapsLink('https://www.google.com/maps')?.kind).toBe('unsupported');
  });

  it('junk → null', () => {
    for (const junk of [
      '',
      '   ',
      'kebab',
      'https://example.com/maps/place/x',
      'https://google.com.evil.com/maps/place/x',
      'https://evil.com/?u=https://maps.app.goo.gl/x',
      'https://www.google.com/search?q=pizza',
      'javascript:alert(1)',
      'https://user:pw@maps.app.goo.gl/x',
      'https://maps.app.goo.gl:8443/x',
      'ftp://maps.google.com/?cid=1',
    ]) {
      expect(parseMapsLink(junk), junk).toBeNull();
    }
  });
});

describe('looksLikeMapsLink / hosts / labels', () => {
  it('detects maps links (also partial ones while typing)', () => {
    expect(looksLikeMapsLink('https://maps.app.goo.gl/')).toBe(true);
    expect(looksLikeMapsLink(GOOGLEPLEX)).toBe(true);
    expect(looksLikeMapsLink(CONSENT)).toBe(true);
    expect(looksLikeMapsLink('https://goo.gl/maps/abc')).toBe(true);
    expect(looksLikeMapsLink('https://share.google/x')).toBe(true);
    expect(looksLikeMapsLink('check maps.app.goo.gl/abc please')).toBe(true);
  });
  it('ignores everything else', () => {
    expect(looksLikeMapsLink('kebab dalston')).toBe(false);
    expect(looksLikeMapsLink('https://www.google.com/search?q=pizza')).toBe(false);
    expect(looksLikeMapsLink('https://example.com')).toBe(false);
    expect(looksLikeMapsLink('google maps')).toBe(false);
  });
  it('host allowlist (Worker SSRF guard)', () => {
    expect(isAllowedMapsHost('maps.app.goo.gl')).toBe(true);
    expect(isAllowedMapsHost('www.google.co.uk')).toBe(true);
    expect(isAllowedMapsHost('consent.google.com')).toBe(true);
    expect(isAllowedMapsHost('google.com.evil.com')).toBe(false);
    expect(isAllowedMapsHost('169.254.169.254')).toBe(false);
    expect(isAllowedMapsHost('localhost')).toBe(false);
  });
  it('link row host label', () => {
    expect(linkHostLabel('https://maps.app.goo.gl/abc')).toBe('maps.app.goo.gl/…');
    expect(linkHostLabel(GOOGLEPLEX)).toBe('google.com/…');
  });
});
