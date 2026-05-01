// ==UserScript==
// @name         YouTube Quick Unsubscribe
// @namespace    https://github.com/local/yt-quick-unsub
// @version      3.0.0
// @description  Adds "Unsubscribe" button under each video + in ⋮ menu. Supports new lockup layout.
// @author       local
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

'use strict';

const CARD_SEL = [
  'ytd-rich-item-renderer',
  'ytd-compact-video-renderer',
  'ytd-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
].join(',');

function findChannelAnchor(card) {
  return card.querySelector('a[href^="/@"], a[href*="/channel/UC"], a[href*="/@"][href$="/videos"]');
}

function channelFromCard(card) {
  const anchor = findChannelAnchor(card);
  if (!anchor) return null;
  let href = new URL(anchor.href, location.href).href;
  href = href.replace(/\/(videos|shorts|about|community|playlists|featured)(\/.*)?$/, '');
  const name = anchor.textContent?.trim() || 'this channel';
  const channelId = href.match(/\/channel\/(UC[\w-]+)/)?.[1] ?? null;
  return { href, name, channelId };
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg) {
  document.getElementById('yqu-toast')?.remove();
  const t = document.createElement('div');
  t.id = 'yqu-toast';
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
    background: '#212121', color: '#fff', padding: '10px 20px', borderRadius: '4px',
    fontSize: '14px', fontFamily: 'Roboto, Arial, sans-serif', zIndex: '99999',
    boxShadow: '0 2px 12px rgba(0,0,0,.4)', pointerEvents: 'none', transition: 'opacity .3s',
  });
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 320); }, 3200);
}

async function resolveChannelData(url) {
  try {
    const html = await (await fetch(url, { credentials: 'include' })).text();
    const channelId =
      html.match(/"externalChannelId":"(UC[\w-]+)"/)?.[1] ??
      html.match(/"channelId":"(UC[\w-]+)"/)?.[1] ??
      null;
    const clickTrackingParams =
      html.match(/"clickTrackingParams":"([^"]+)"[^{]*"commandMetadata"[^{]*"apiUrl":"\/youtubei\/v1\/subscription\/unsubscribe"/)?.[1] ??
      html.match(/"clickTrackingParams":"([^"]{10,})"[^}]{0,200}"unsubscribeEndpoint"/)?.[1] ??
      null;
    return { channelId, clickTrackingParams };
  } catch {
    return { channelId: null, clickTrackingParams: null };
  }
}

async function sapisidHash() {
  const sapisid =
    document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1] ??
    document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1];
  if (!sapisid) return null;
  const ts = Math.floor(Date.now() / 1000);
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${ts} ${sapisid} https://www.youtube.com`));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${ts}_${hex}`;
}

function getYtContext() {
  const cfg = window.ytcfg;
  return {
    clientName:    cfg?.get?.('INNERTUBE_CLIENT_NAME')    ?? 'WEB',
    clientVersion: cfg?.get?.('INNERTUBE_CLIENT_VERSION') ?? '2.20260430.08.00',
    apiKey:        cfg?.get?.('INNERTUBE_API_KEY')        ?? 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    hl:            cfg?.get?.('HL')                       ?? 'en',
    gl:            cfg?.get?.('GL')                       ?? 'US',
    visitorData:   cfg?.get?.('VISITOR_DATA'),
    idToken:       cfg?.get?.('ID_TOKEN'),
    sessionIndex:  cfg?.get?.('SESSION_INDEX')            ?? '0',
  };
}

async function doUnsubscribe({ href, name, channelId }) {
  showToast(`⏳ Unsubscribing from ${name}…`);

  const data = await resolveChannelData(href);
  if (data.channelId) channelId = data.channelId;
  if (!channelId) { showToast(`❌ Could not find channel ID for "${name}"`); return; }

  const auth = await sapisidHash();
  if (!auth) { showToast('❌ Session error — are you logged in?'); return; }

  const { clientName, clientVersion, apiKey, hl, gl, visitorData, idToken, sessionIndex } = getYtContext();
  const client = { clientName, clientVersion, hl, gl };
  if (visitorData) client.visitorData = visitorData;

  const context = { client };
  if (data.clickTrackingParams) context.clickTracking = { clickTrackingParams: data.clickTrackingParams };

  const headers = {
    'Content-Type':             'application/json',
    'X-Origin':                 'https://www.youtube.com',
    'X-Goog-AuthUser':          sessionIndex,
    'X-Youtube-Client-Name':    '1',
    'X-Youtube-Client-Version': clientVersion,
    'Authorization':            auth,
  };
  if (visitorData) headers['X-Goog-Visitor-Id']       = visitorData;
  if (idToken)     headers['X-Youtube-Identity-Token'] = idToken;

  try {
    const res = await fetch(
      `https://www.youtube.com/youtubei/v1/subscription/unsubscribe?key=${apiKey}`,
      { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context, channelIds: [channelId] }) }
    );
    if (res.ok) {
      showToast(`✅ Unsubscribed from ${name}`);
    } else {
      console.error('[YQU] API error:', await res.text().catch(() => ''));
      showToast(`❌ Failed (HTTP ${res.status}) — see console`);
    }
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

// ── Video card button ──────────────────────────────────────────────────────────

function addButtonToCard(card) {
  if (card.querySelector('.yqu-btn')) return;
  const ch = channelFromCard(card);
  if (!ch) return;

  const btn = document.createElement('button');
  btn.className = 'yqu-btn';
  btn.textContent = 'Unsubscribe';
  btn.title = `Unsubscribe from ${ch.name}`;
  Object.assign(btn.style, {
    display: 'inline-block', marginTop: '4px', padding: '2px 10px',
    fontSize: '12px', fontWeight: '700', fontFamily: 'Roboto, Arial, sans-serif',
    color: '#c00', background: 'transparent', border: '2px solid #c00',
    borderRadius: '12px', cursor: 'pointer', lineHeight: '1.8',
    letterSpacing: '0.02em', transition: 'background .15s, color .15s',
  });
  btn.addEventListener('mouseover', () => { btn.style.background = '#c00'; btn.style.color = '#fff'; });
  btn.addEventListener('mouseout',  () => { btn.style.background = 'transparent'; btn.style.color = '#c00'; });
  btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); doUnsubscribe(ch); });

  const anchor = findChannelAnchor(card);
  const insertAfter = anchor?.closest('yt-formatted-string, span, div') ?? anchor;
  insertAfter?.parentNode?.insertBefore(btn, insertAfter.nextSibling);
}

function scanCards() {
  document.querySelectorAll(CARD_SEL).forEach(addButtonToCard);
}

let _scanTimer = null;
new MutationObserver(() => {
  clearTimeout(_scanTimer);
  _scanTimer = setTimeout(scanCards, 500);
}).observe(document.documentElement, { childList: true, subtree: true });
setTimeout(scanCards, 800);
setTimeout(scanCards, 2500);

// ── ⋮ menu item ───────────────────────────────────────────────────────────────

let pendingChannel = null;

document.addEventListener('click', e => {
  const menuRenderer = e.target.closest('ytd-menu-renderer');
  if (!menuRenderer) return;
  const card = menuRenderer.closest(CARD_SEL);
  if (card) pendingChannel = channelFromCard(card);
}, true);

new MutationObserver(mutations => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const listbox = node.matches?.('tp-yt-paper-listbox') ? node : node.querySelector?.('tp-yt-paper-listbox');
      if (listbox) injectMenuItem(listbox);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

function injectMenuItem(listbox) {
  if (!pendingChannel || listbox.querySelector('.yqu-item')) return;
  const ch = pendingChannel;

  const item = document.createElement('tp-yt-paper-item');
  item.className = 'yqu-item style-scope tp-yt-paper-listbox';
  item.setAttribute('role', 'option');
  item.setAttribute('tabindex', '0');
  Object.assign(item.style, {
    display: 'flex', alignItems: 'center', padding: '0 16px', minHeight: '36px',
    cursor: 'pointer', fontSize: '1.4rem', fontFamily: 'Roboto, Arial, sans-serif',
    color: 'var(--yt-spec-text-primary, #0f0f0f)', whiteSpace: 'nowrap',
    boxSizing: 'border-box', borderTop: '1px solid var(--yt-spec-10-percent-layer, rgba(0,0,0,0.1))',
  });
  item.innerHTML = `
    <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-right:16px;flex-shrink:0;opacity:.75;">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M20 18.69L4.12 2.81 2.81 4.12l2.19 2.19C4.37 7.27 4 8.6 4 10v5l-2 2v1h14.73l2 2 1.27-1.27zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.27V10c0-3.07-1.64-5.64-4.5-6.32V3c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.48.11-.92.29-1.35.5L18 14.73z"/>
      </svg>
    </span>
    <span>Unsubscribe from ${esc(ch.name)}</span>
  `;
  item.addEventListener('mouseover', () => item.style.background = 'var(--yt-spec-badge-chip-background, rgba(0,0,0,0.07))');
  item.addEventListener('mouseout',  () => item.style.background = '');
  item.addEventListener('click', e => {
    e.stopPropagation();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    doUnsubscribe(ch);
  });

  listbox.appendChild(item);
}
