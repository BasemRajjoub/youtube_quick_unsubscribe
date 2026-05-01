// ==UserScript==
// @name         YouTube Quick Unsubscribe
// @version      6.0.0
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

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, ttl = 5000) {
  console.log('[YQU]', msg);
  let t = document.getElementById('yqu-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'yqu-toast';
    Object.assign(t.style, {
      position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
      background: '#212121', color: '#fff', padding: '10px 22px', borderRadius: '4px',
      fontSize: '14px', fontFamily: 'Roboto,Arial,sans-serif', zIndex: '99999',
      boxShadow: '0 2px 12px rgba(0,0,0,.5)', pointerEvents: 'none',
      transition: 'opacity .3s', maxWidth: '500px', textAlign: 'center',
    });
    document.body.appendChild(t);
  }
  clearTimeout(t._timer);
  t.style.opacity = '1';
  t.textContent = msg;
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, ttl);
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

async function unsubscribe(channelUrl, name) {
  toast(`⏳ Opening ${name}'s channel…`);
  const popup = window.open(channelUrl, '_yqu', 'width=800,height=500,menubar=no,toolbar=no,location=no');
  if (!popup) {
    toast('❌ Popup blocked — allow popups for youtube.com and try again.');
    return;
  }

  await poll(() => {
    try {
      if (!popup.document?.head) return false;
      const s = popup.document.createElement('style');
      s.textContent = BLOCK_CSS;
      popup.document.head.appendChild(s);
      return true;
    } catch(e) { return false; }
  }, 5000, 100);

  toast(`⏳ Waiting for subscribe button…`);
  const loaded = await poll(() => {
    try {
      if (popup.document.querySelector(BTN_SEL)) { popup.stop(); return true; }
      return false;
    } catch(e) { return false; }
  }, 12000, 150);

  if (!loaded) {
    popup.close();
    toast('❌ Subscribe button not found — try again.');
    return;
  }

  toast(`⏳ Clicking options button…`);
  click(popup.document.querySelector(BTN_SEL));
  await sleep(400);

  toast(`⏳ Looking for Unsubscribe in menu…`);
  const ITEM_SEL = 'tp-yt-paper-item, ytd-menu-navigation-item-renderer, ytd-menu-service-item-renderer, yt-list-item-view-model';
  const unsubItem = [...popup.document.querySelectorAll(ITEM_SEL)]
    .find(el => el.textContent.trim().toLowerCase().includes('unsubscribe'));

  if (!unsubItem) {
    toast(`❌ "Unsubscribe" not in menu — leaving popup open so you can inspect.`);
    return;
  }

  click(unsubItem);

  toast(`⏳ Waiting for confirm dialog…`);
  const CONFIRM_SEL = '#confirm-button button, ytd-dialog #confirm-button button, tp-yt-paper-button[dialog-confirm], yt-button-shape#confirm-button button';
  const confirmed = await poll(() => {
    try { return !!popup.document.querySelector(CONFIRM_SEL); }
    catch(e) { return false; }
  }, 5000, 200);

  if (!confirmed) {
    popup.close();
    toast(`⚠️ Confirm dialog did not appear — may already be unsubscribed.`);
    return;
  }

  click(popup.document.querySelector(CONFIRM_SEL));
  await sleep(400);
  popup.close();
  toast(`✅ Unsubscribed from ${name}!`);
}

// ─── Inject Unsubscribe button under each video card's channel name ───────────

const CARD_SEL = 'ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer';

function addButton(card) {
  if (card.querySelector('.yqu-btn')) return;
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
  btn.onmouseover = () => { btn.style.background = '#c00'; btn.style.color = '#fff'; };
  btn.onmouseout  = () => { btn.style.background = 'transparent'; btn.style.color = '#c00'; };
  btn.onclick = e => { e.preventDefault(); e.stopPropagation(); unsubscribe(href, name); };

  const anchor = a.closest('yt-formatted-string, span') ?? a;
  anchor.parentNode?.insertBefore(btn, anchor.nextSibling);
}

// ─── MutationObserver to catch new cards (infinite scroll) ───────────────────

let _scanTimer;
new MutationObserver(() => {
  clearTimeout(_scanTimer);
  _scanTimer = setTimeout(() => document.querySelectorAll(CARD_SEL).forEach(addButton), 500);
}).observe(document.documentElement, { childList: true, subtree: true });

setTimeout(() => document.querySelectorAll(CARD_SEL).forEach(addButton), 800);
