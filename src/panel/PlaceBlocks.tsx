/**
 * Non-Google place blocks (DESIGN §9.4, §9.6):
 *  - DemoPlaceBlock: `.gblock` lookalike for the FICTIONAL demo shops only (never a real place ID,
 *    never the word "Google"). `Open in Maps` and the info rows toast `Demo shop — it isn't on
 *    Google Maps.`; the hours row toggles the fictional hours list.
 *  - OsmPlaceBlock: fallback map (MapLibre/OSM) — OSM name/address rows + `© OpenStreetMap contributors`.
 *  - PlaceUnavailableBlock: a real Google place while the Google map is unavailable (no Google content).
 *  - DemoPlaceCompact: modal-sized demo card (instead of the compact Google element).
 */
import { useId, useState, type CSSProperties } from 'react';
import { links } from '../config';
import { categoryLabel } from '../lib/categories';
import { mapsUrlFor } from '../lib/place';
import { openExternal } from '../lib/nav';
import { useStore } from '../store';
import type { DemoPlaceInfo, Place } from '../types';
import { Button, Icon } from '../ui';

const DEMO_TOAST = "Demo shop — it isn't on Google Maps.";

function demoToast() {
  useStore.getState().toast(DEMO_TOAST);
}

function openLine(hours: string) {
  return /open 24 hours/i.test(hours) ? (
    <span className="open">Open 24 hours</span>
  ) : (
    <>
      <span className="open">Open</span>
      <span className="dot-sep">·</span>
      <span>{hours}</span>
    </>
  );
}

export function DemoPlaceBlock({ name, category, demo }: { name: string; category: Place['category']; demo: DemoPlaceInfo }) {
  const [hoursOpen, setHoursOpen] = useState(false);
  const hoursId = useId();
  const [m1, m2, m3] = demo.photos;
  const bg = (id: string | undefined, w: number, h: number): CSSProperties | undefined =>
    id ? { backgroundImage: `url('${links.unsplashPhoto(id, w, h)}')` } : undefined;

  return (
    <section className="gplace" aria-label="About this place">
      <div className="sec-title">
        <span>About this place</span>
      </div>
      <div className="gblock">
        <div className="gb-attr">
          <span className="gb-demo">Demo shop · fictional business</span>
          <span className="gb-info" data-tip="Seeded demo shops are fictional. Real shops on the map show Google's details here." tabIndex={0} role="note" aria-label="Seeded demo shops are fictional. Real shops on the map show Google's details here.">
            <Icon name="info" />
          </span>
        </div>
        <div className="gb-body">
          <div className="gb-name">{name}</div>
          <div className="ph-row">
            <span>{demo.rating.toFixed(1)}</span>
            <span className="stars" style={{ '--v': demo.rating } as CSSProperties} aria-hidden="true">
              ★★★★★
            </span>
            <span className="sr">{demo.rating.toFixed(1)} out of 5 stars</span>
            <span className="gb-link">({demo.reviews.toLocaleString('en-GB')})</span>
          </div>
          <div className="ph-row">
            <span>{categoryLabel(category)}</span>
            <span className="dot-sep">·</span>
            <span>{demo.price}</span>
          </div>
          <div className="ph-row">{openLine(demo.hours)}</div>
          <button type="button" className="gb-btn hit" onClick={demoToast}>
            Open in Maps
          </button>
          {m1 ? (
            <div className="gb-media" aria-label="Photos" role="img">
              <div className="m1" style={bg(m1, 360, 480)}>
                <span>
                  <Icon name="photo_library" size={15} />
                  {demo.photoCount} photos
                </span>
              </div>
              <div className="m2" style={bg(m2, 360, 240)} />
              <div className="m3" style={bg(m3, 360, 240)} />
            </div>
          ) : null}
        </div>
        <div className="gb-rows">
          <button type="button" className="irow" onClick={demoToast}>
            <Icon name="location_on" />
            <span className="main">{demo.address}</span>
          </button>
          <button type="button" className="irow" aria-expanded={hoursOpen} aria-controls={hoursId} onClick={() => setHoursOpen((o) => !o)}>
            <Icon name="schedule" />
            <span className="main">{openLine(demo.hours)}</span>
            <Icon name="expand_more" className={['trail', 'gb-chev', hoursOpen ? 'up' : ''].filter(Boolean).join(' ')} />
          </button>
          <ul id={hoursId} className="gb-hours" hidden={!hoursOpen}>
            {demo.hoursList.map((line) => {
              const [day, ...rest] = line.split(' ');
              return (
                <li key={line}>
                  <span>{day}</span>
                  <span>{rest.join(' ')}</span>
                </li>
              );
            })}
          </ul>
          <button type="button" className="irow" onClick={demoToast}>
            <Icon name="public" />
            <span className="main gb-link">{demo.website}</span>
          </button>
          <button type="button" className="irow" onClick={demoToast}>
            <Icon name="call" />
            <span className="main num">{demo.phone}</span>
          </button>
        </div>
      </div>
    </section>
  );
}

export function OsmPlaceBlock({ place }: { place: Place }) {
  const url = mapsUrlFor(place);
  const kind = place.osm?.value ? place.osm.value.replace(/_/g, ' ') : categoryLabel(place.category);
  return (
    <section className="gplace" aria-label="About this place">
      <div className="sec-title">
        <span>About this place</span>
      </div>
      <div className="gblock">
        <div className="gb-attr">
          <span className="gb-demo">OpenStreetMap place</span>
        </div>
        <div className="gb-body">
          <div className="gb-name">{place.name || 'Unnamed place'}</div>
          <div className="ph-row">
            <span className="gb-kind">{kind}</span>
          </div>
        </div>
        <div className="gb-rows">
          {place.address || place.city ? (
            <div className="irow static">
              <Icon name="location_on" />
              <span className="main">{[place.address, place.city].filter(Boolean).join(', ')}</span>
            </div>
          ) : null}
          {url ? (
            <a className="irow" href={url} target="_blank" rel="noopener noreferrer">
              <Icon name="public" />
              <span className="main">View on OpenStreetMap</span>
              <Icon name="open_in_new" className="trail" />
            </a>
          ) : null}
        </div>
        <p className="gb-credit">© OpenStreetMap contributors</p>
      </div>
    </section>
  );
}

/** Real Google place while the Google map is unavailable: no Google content may be shown. */
export function PlaceUnavailableBlock({ place }: { place: Place }) {
  const url = mapsUrlFor(place) ?? links.googleMapsLatLng(place.location);
  return (
    <section className="gplace" aria-label="About this place">
      <div className="sec-title">
        <span>About this place</span>
      </div>
      <div className="gmp-err gblock">
        <Icon name="error" />
        <p className="gmp-err-t">Place details need Google Maps</p>
        <p className="gmp-err-s">Google Maps is unavailable right now, so we can't show this shop's details.</p>
        <div className="gmp-err-actions">
          <Button variant="text" icon="open_in_new" onClick={() => openExternal(url)}>
            Open in Google Maps
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Modal-sized card for fictional demo shops (launch Review / claim Verify). */
export function DemoPlaceCompact({ place }: { place: Place }) {
  const demo = place.demo;
  return (
    <div className="pc-demo">
      <span className="pc-emoji" aria-hidden="true">
        {place.emoji}
      </span>
      <span className="pc-tx">
        <b>{place.name || 'Demo shop'}</b>
        <small>
          {categoryLabel(place.category)}
          {demo ? ` · ${demo.address}` : ''}
        </small>
        <small className="pc-demo-tag">Demo shop · fictional business</small>
      </span>
    </div>
  );
}
