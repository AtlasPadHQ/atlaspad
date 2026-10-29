/**
 * Share modal (DESIGN §12.5): 1200×675 card preview, editable post (≤280), Post on X (intent),
 * Copy link, Download image (`cornershop-KEBAB.png`), and on mobile `More` (Web Share API, with the
 * PNG attached when the browser can share files). Renders when store.modal?.kind === 'share'.
 * Contract: default export, no props.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { links, shareOrigin } from '../config';
import { copyWithToast } from '../lib/clipboard';
import { useIsMobile } from '../lib/media';
import { openExternal } from '../lib/nav';
import { useStore } from '../store';
import type { Coin, ModalState, ShareVariant } from '../types';
import { Button, Modal, ModalHeader, Sk, TextArea, XGlyph, useLatest } from '../ui';
import { renderPlaceShareCard, renderShareCard } from './shareCard';
import './share.css';

type ShareModalState = Extract<ModalState, { kind: 'share' }>;

/** Post text per variant (DESIGN §16.9). */
export function sharePostText(variant: ShareVariant, coin: Coin | undefined): string {
  if (!coin || variant === 'place') return 'This shop has no coin yet. First launch wins.';
  switch (variant) {
    case 'launched':
      return `I just launched $${coin.ticker} on AtlasPad — the coin for ${coin.name}. 100% of creator fees are held for the shop's verified owner.`;
    case 'owner':
      return `We're the verified owner of $${coin.ticker} on AtlasPad. 100% of creator fees from every trade are held for our shop.`;
    case 'coin':
    default:
      return `$${coin.ticker} is the coin for ${coin.name} on AtlasPad. 100% of creator fees are held for the shop's verified owner. ${coin.logo.emoji}`;
  }
}

/** Public URL for a coin (`/c/<mint>`) or a place (`/p/<placeId>`); OSM/link places → app root. */
export function shareUrlFor(placeId: string, coin: Coin | undefined): string {
  if (coin) return links.shareCoin(coin.mint);
  if (placeId.startsWith('osm:') || placeId.startsWith('link:')) return `${shareOrigin()}/`;
  return links.sharePlace(placeId);
}

export function shareFileName(coin: Coin | undefined): string {
  return coin ? `atlaspad-${coin.ticker}.png` : 'atlaspad-shop.png';
}

/** Open the X intent in a new tab (DESIGN §12.5). */
export function postOnX(text: string, url: string): void {
  openExternal(links.xIntent(text, url));
}

export default function ShareModal() {
  const modal = useStore((s) => s.modal);
  const current = modal?.kind === 'share' ? (modal as ShareModalState) : null;
  const m = useLatest(current);
  const open = current != null;
  const closeModal = useStore((s) => s.closeModal);
  const coin = useStore((s) => (m ? s.coins[m.placeId] : undefined));
  const mobile = useIsMobile();
  const h = useId();

  const variant: ShareVariant = m?.variant ?? (coin ? 'coin' : 'place');
  const effVariant: ShareVariant = coin ? (variant === 'place' ? 'coin' : variant) : 'place';
  const url = m ? shareUrlFor(m.placeId, coin) : shareOrigin();

  const [text, setText] = useState('');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const blobRef = useRef<Blob | null>(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  // reset the post text on every open
  const openKey = open && m ? `${m.placeId}:${effVariant}` : null;
  useEffect(() => {
    if (!openKey) return;
    setText(sharePostText(effVariant, useStore.getState().coins[m?.placeId ?? '']));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  // render the card (once per open; the snapshot is enough for a share image)
  useEffect(() => {
    if (!openKey || !m) return;
    let alive = true;
    let objectUrl: string | null = null;
    setBlob(null);
    setPreview(null);
    setFailed(false);
    const snapshot = useStore.getState().coins[m.placeId];
    const job = snapshot
      ? renderShareCard(snapshot, effVariant === 'owner' ? 'owner' : effVariant === 'launched' ? 'launched' : 'coin')
      : renderPlaceShareCard();
    job
      .then((b) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(b);
        blobRef.current = b;
        setBlob(b);
        setPreview(objectUrl);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      blobRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  const download = () => {
    const b = blobRef.current;
    if (!b) return;
    const href = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = href;
    a.download = shareFileName(coin);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 4000);
    useStore.getState().toast('Image saved', 'ok');
  };

  const more = async () => {
    const title = coin ? `$${coin.ticker} on AtlasPad` : 'AtlasPad';
    const b = blobRef.current;
    const data: ShareData = { title, text, url };
    try {
      if (b && typeof File !== 'undefined') {
        const file = new File([b], shareFileName(coin), { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) data.files = [file];
      }
      await navigator.share(data);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      try {
        // some browsers reject files: retry with text + url only
        await navigator.share({ title, text, url });
      } catch (e2) {
        if ((e2 as { name?: string })?.name !== 'AbortError') useStore.getState().toast("Couldn't open the share sheet.", 'error');
      }
    }
  };

  const title = coin ? `Share $${coin.ticker}` : 'Share this shop';

  return (
    <Modal open={open} onClose={closeModal} labelledBy={h} className="share-dlg">
      <ModalHeader onClose={closeModal} />
      <h2 id={h} translate="no">
        {title}
      </h2>
      <div className="share-card" aria-busy={!preview && !failed ? true : undefined}>
        {preview ? (
          <img src={preview} alt={coin ? `Share card for $${coin.ticker}` : 'Share card: no coin yet, first launch wins'} />
        ) : failed ? (
          <p className="share-card-err">Couldn't draw the share image. You can still post the link.</p>
        ) : (
          <Sk w="100%" h="100%" r={12} />
        )}
      </div>
      <TextArea label="Post" value={text} onChange={(e) => setText(e.target.value)} maxLength={280} rows={3} counter />
      <div className="share-btns">
        <Button variant="primary" lead={<XGlyph />} onClick={() => postOnX(text, url)} data-autofocus>
          Post on X
        </Button>
        <Button variant="outline" icon="link" onClick={() => void copyWithToast(url, 'Link copied')}>
          Copy link
        </Button>
        <Button variant="outline" icon="download" disabled={!blob} onClick={download}>
          Download image
        </Button>
        {mobile && canShare ? (
          <Button variant="outline" icon="ios_share" onClick={() => void more()}>
            More
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}
