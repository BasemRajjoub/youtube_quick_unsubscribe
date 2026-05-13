// ==UserScript==
// @name         YouTube Quick Unsubscribe
// @version      6.3.0
// @description  Adds Unsubscribe button to every video card on the subscriptions feed.
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

'use strict';

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function click(el) {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, buttons: 1 }));
}

function poll(fn, timeout = 12000, interval = 400) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (fn())                      { clearInterval(id); resolve(true);  return; }
      if (Date.now() - t0 > timeout) { clearInterval(id); resolve(false); }
    }, interval);
  });
}

// ─── Toasts (stacked: one row per running operation) ─────────────────────────

function ensureToastBox() {
  let box = document.getElementById('yqu-toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'yqu-toasts';
    Object.assign(box.style, {
      position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
      display: 'flex', flexDirection: 'column-reverse', gap: '6px',
      zIndex: '99999', pointerEvents: 'none',
    });
    document.body.appendChild(box);
  }
  return box;
}

function newToast() {
  const row = document.createElement('div');
  Object.assign(row.style, {
    background: '#212121', color: '#fff', padding: '8px 18px', borderRadius: '4px',
    fontSize: '13px', fontFamily: 'Roboto,Arial,sans-serif',
    boxShadow: '0 2px 12px rgba(0,0,0,.5)', transition: 'opacity .3s',
    opacity: '1', textAlign: 'center', maxWidth: '500px',
  });
  ensureToastBox().appendChild(row);
  let fadeTimer;
  const remove = () => { row.style.opacity = '0'; setTimeout(() => row.remove(), 350); };
  return {
    update(msg) {
      console.log('[YQU]', msg);
      row.textContent = msg;
      clearTimeout(fadeTimer);
    },
    finish(msg, ttl = 3500) {
      console.log('[YQU]', msg);
      row.textContent = msg;
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(remove, ttl);
    },
  };
}

// ─── Core: open channel in popup and click Unsubscribe ───────────────────────

const BTN_SEL = [
  '#notification-preference-button button',
  '#notification-button button',
  '#menu-button button',
  'ytd-subscribe-button-renderer button',
  'yt-subscribe-button-view-model button',
  'button[aria-label*="Options" i]',
].join(', ');

const BLOCK_CSS = `
  img, video, ytd-thumbnail, ytd-rich-grid-renderer, ytd-rich-item-renderer,
  ytd-shelf-renderer, ytd-video-renderer, #secondary, #related,
  ytd-ad-slot-renderer, .ytd-masthead { display:none!important; }
`;

// CSP that blocks image/media/font/object fetches in the popup. Scripts are
// left alone — YouTube's app still has to run for us to detect subscription
// state. Injected as the first child of <head> as early as possible.
const BLOCK_CSP = [
  "img-src 'none'",
  "media-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
].join('; ');

const STRIP_SEL = 'img, video, source, iframe, link[as="image"], link[rel*="icon"]';

// Strips src/srcset/poster/href from anything image-like, including descendants.
function stripMedia(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.matches?.(STRIP_SEL)) {
    node.removeAttribute('src');
    node.removeAttribute('srcset');
    node.removeAttribute('poster');
    if (node.tagName === 'LINK') node.removeAttribute('href');
  }
  node.querySelectorAll?.(STRIP_SEL).forEach(stripMedia);
}

// Set up the popup so it loads as little as possible: CSP blocks future
// fetches of img/media/font; the MutationObserver strips src/srcset off
// anything that slips through; BLOCK_CSS hides what's already painted.
function harden(popup) {
  try {
    const doc = popup.document;
    if (!doc?.head) return false;

    const csp = doc.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = BLOCK_CSP;
    doc.head.insertBefore(csp, doc.head.firstChild);

    const style = doc.createElement('style');
    style.textContent = BLOCK_CSS;
    doc.head.appendChild(style);

    stripMedia(doc.documentElement);
    new popup.MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) stripMedia(n);
    }).observe(doc.documentElement, { childList: true, subtree: true });

    return true;
  } catch(e) {
    return false;
  }
}

let _popupSeq = 0;
async function unsubscribe(channelUrl, name) {
  const t = newToast();
  t.update(`⏳ Opening ${name}…`);

  // Unique window name so parallel clicks each get their own popup instead of
  // hijacking a shared one. The popup must be opened synchronously here to
  // preserve the user-gesture that allowed it.
  const winName = `_yqu_${++_popupSeq}_${Date.now()}`;
  const popup = window.open(channelUrl, winName, 'width=720,height=480,menubar=no,toolbar=no,location=no');
  if (!popup) {
    t.finish('❌ Popup blocked — allow popups for youtube.com and try again.');
    return false;
  }

  // Inject CSP + media-stripping observer as early as possible to keep the
  // popup from downloading thumbnails, banners, fonts, etc. Poll fast (30ms)
  // so we get into <head> before most resources are queued.
  await poll(() => harden(popup), 5000, 30);

  t.update(`⏳ ${name}: loading channel…`);
  const SUB_WRAPPER_SEL = 'ytd-subscribe-button-renderer, yt-subscribe-button-view-model';
  const loaded = await poll(() => {
    try {
      if (popup.document.querySelector(SUB_WRAPPER_SEL)) { popup.stop(); return true; }
      return false;
    } catch(e) { return false; }
  }, 12000, 150);

  if (!loaded) {
    popup.close();
    t.finish(`❌ ${name}: subscribe button not found.`);
    return false;
  }

  // Bail out if the user isn't actually subscribed — otherwise the fallback
  // selector lands on the red "Subscribe" button and clicking it subscribes.
  const isSubscribed = (() => {
    try {
      if (popup.document.querySelector('#notification-preference-button, #notification-button')) return true;
      const wrapper = popup.document.querySelector(SUB_WRAPPER_SEL);
      if (!wrapper) return false;
      if (wrapper.hasAttribute('subscribed') || wrapper.subscribed === true) return true;
      const txt = (wrapper.textContent || '').trim().toLowerCase();
      return /\bsubscribed\b|\bjoined\b/.test(txt);
    } catch(e) { return false; }
  })();

  if (!isSubscribed) {
    popup.close();
    t.finish(`ℹ️ Not subscribed to ${name} — nothing to do.`);
    return false;
  }

  t.update(`⏳ ${name}: opening menu…`);
  const optionsBtn = popup.document.querySelector(BTN_SEL);
  if (!optionsBtn) {
    popup.close();
    t.finish(`❌ ${name}: options button not found.`);
    return false;
  }
  click(optionsBtn);
  await sleep(400);

  const ITEM_SEL = 'tp-yt-paper-item, ytd-menu-navigation-item-renderer, ytd-menu-service-item-renderer, yt-list-item-view-model';
  const unsubItem = [...popup.document.querySelectorAll(ITEM_SEL)]
    .find(el => el.textContent.trim().toLowerCase().includes('unsubscribe'));

  if (!unsubItem) {
    t.finish(`❌ ${name}: "Unsubscribe" not in menu — popup left open.`);
    return false;
  }

  click(unsubItem);

  t.update(`⏳ ${name}: confirming…`);
  const CONFIRM_SEL = '#confirm-button button, ytd-dialog #confirm-button button, tp-yt-paper-button[dialog-confirm], yt-button-shape#confirm-button button';
  const confirmed = await poll(() => {
    try { return !!popup.document.querySelector(CONFIRM_SEL); }
    catch(e) { return false; }
  }, 5000, 200);

  if (!confirmed) {
    popup.close();
    t.finish(`⚠️ ${name}: no confirm dialog — may already be unsubscribed.`);
    return false;
  }

  click(popup.document.querySelector(CONFIRM_SEL));
  await sleep(400);
  popup.close();
  t.finish(`✅ Unsubscribed from ${name}`);
  return true;
}

// ─── Inject Unsubscribe button under each video card's channel name ───────────

const CARD_SEL = 'ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer';

function addButton(card) {
  if (card.querySelector('.yqu-btn')) return;
  // Skip the watch-page suggestions sidebar — those are mixed with channels
  // the user isn't subscribed to, where this button can't safely act.
  if (card.closest('#secondary, #related, ytd-watch-next-secondary-results-renderer')) return;
  const a = card.querySelector('a[href^="/@"], a[href*="/channel/UC"]');
  if (!a) return;

  const href = new URL(a.href, location.href).href
    .replace(/\/(videos|shorts|about|featured|community|playlists)(\/.*)?$/, '');
  const name = a.textContent?.trim() || 'this channel';

  const btn = document.createElement('button');
  btn.className = 'yqu-btn';
  btn.textContent = 'Unsubscribe';
  Object.assign(btn.style, {
    display: 'inline-block', marginTop: '4px',
    padding: '2px 10px', fontSize: '12px', fontWeight: '700',
    fontFamily: 'Roboto,Arial,sans-serif', lineHeight: '1.8',
    color: '#c00', background: 'transparent',
    border: '2px solid #c00', borderRadius: '12px',
    cursor: 'pointer', transition: 'all .15s',
  });
  btn.onmouseover = () => { if (!btn.disabled) { btn.style.background = '#c00'; btn.style.color = '#fff'; } };
  btn.onmouseout  = () => { if (!btn.disabled) { btn.style.background = 'transparent'; btn.style.color = '#c00'; } };
  btn.onclick = async e => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    // Lock this card's button immediately so further clicks queue nothing,
    // but the async unsubscribe() runs concurrently with any other card's
    // own pending call — each has its own popup.
    btn.disabled = true;
    btn.textContent = '…';
    btn.style.cursor = 'wait';
    btn.style.opacity = '0.6';
    btn.style.background = 'transparent';
    btn.style.color = '#c00';
    const ok = await unsubscribe(href, name);
    if (ok) {
      btn.textContent = '✓';
      btn.style.color = '#0a0';
      btn.style.borderColor = '#0a0';
      btn.style.opacity = '1';
      card.style.transition = 'opacity .4s';
      card.style.opacity = '0.35';
    } else {
      btn.disabled = false;
      btn.textContent = 'Unsubscribe';
      btn.style.cursor = 'pointer';
      btn.style.opacity = '1';
    }
  };

  const anchor = a.closest('yt-formatted-string, span') ?? a;
  anchor.parentNode?.insertBefore(btn, anchor.nextSibling);
}

// ─── MutationObserver to catch new cards (infinite scroll) ───────────────────

let _scanTimer;
new MutationObserver(() => {
  clearTimeout(_scanTimer);
  _scanTimer = setTimeout(() => document.querySelectorAll(CARD_SEL).forEach(addButton), 250);
}).observe(document.documentElement, { childList: true, subtree: true });

setTimeout(() => document.querySelectorAll(CARD_SEL).forEach(addButton), 400);
