// ==UserScript==
// @name         YouTube Quick Unsubscribe
// @version      7.0.2
// @description  Adds Unsubscribe button to every video card on the subscriptions feed. Calls YouTube's Innertube API directly — no popups, parallel by default.
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

'use strict';

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

// ─── Core: call YouTube's Innertube API directly ─────────────────────────────

const ORIGIN = 'https://www.youtube.com';
const UC_RE = /\/channel\/(UC[\w-]{20,30})/;
// Protobuf bytes the real web client sends on (un)subscribe. Not strictly
// required by the endpoint, but matches the official traffic.
const UNSUB_PARAMS = 'CgIIAhgA';

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Builds YT's SAPISIDHASH Authorization header. RFC 7235 only allows one
// scheme per Authorization header value, so we pick the first cookie that's
// present (matching what YT's own web client does — it does not space-join
// multiple schemes). Timestamp is seconds. Fallback order matches Google's
// own preference: SAPISID → __Secure-3PAPISID → __Secure-1PAPISID.
async function buildAuthHeader() {
  const ts = Math.floor(Date.now() / 1000);
  for (const [cookie, scheme] of [
    ['SAPISID', 'SAPISIDHASH'],
    ['__Secure-3PAPISID', 'SAPISID3PHASH'],
    ['__Secure-1PAPISID', 'SAPISID1PHASH'],
  ]) {
    const v = getCookie(cookie);
    if (!v) continue;
    const hash = await sha1Hex(`${ts} ${v} ${ORIGIN}`);
    return { header: `${scheme} ${ts}_${hash}`, cookie, timestamp: ts };
  }
  return { header: '', cookie: null, timestamp: ts };
}

function ytCfg() {
  const g = window.ytcfg;
  const get = k => g?.get?.(k) ?? g?.data_?.[k];
  const ctx = get('INNERTUBE_CONTEXT');
  return {
    apiKey: get('INNERTUBE_API_KEY'),
    clientVersion: get('INNERTUBE_CLIENT_VERSION') ?? ctx?.client?.clientVersion,
    sessionIndex: get('SESSION_INDEX') ?? '0',
    visitorData: ctx?.client?.visitorData,
    context: ctx,
  };
}

async function ytApiPost(path, body) {
  const cfg = ytCfg();
  if (!cfg.apiKey || !cfg.context) throw new Error('ytcfg not available (not on a YouTube page?)');
  const auth = await buildAuthHeader();
  if (!auth.header) throw new Error('not signed in — none of SAPISID / __Secure-3PAPISID / __Secure-1PAPISID cookies are visible to JS (may be HttpOnly)');

  const res = await fetch(`${ORIGIN}${path}?key=${encodeURIComponent(cfg.apiKey)}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': auth.header,
      'X-Origin': ORIGIN,
      'X-Goog-AuthUser': String(cfg.sessionIndex || '0'),
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': cfg.clientVersion,
      'X-Youtube-Bootstrap-Logged-In': 'true',
      ...(cfg.visitorData ? { 'X-Goog-Visitor-Id': cfg.visitorData } : {}),
    },
    body: JSON.stringify({ context: cfg.context, ...body }),
  });
  const json = await res.json().catch(() => null);

  if (!res.ok) {
    // Diagnostic dump so we can see why the auth was rejected without
    // leaking the actual cookie hash.
    console.warn('[YQU] API error', {
      endpoint: path,
      status: res.status,
      error: json?.error?.message,
      authCookieUsed: auth.cookie,
      authPreview: auth.header.replace(/_[a-f0-9]{40}/g, '_<sha1>'),
      tsSeconds: auth.timestamp,
      clientVersion: cfg.clientVersion,
      sessionIndex: cfg.sessionIndex,
      visitorDataPresent: !!cfg.visitorData,
      sessionCookiesVisible: document.cookie.split(';')
        .map(c => c.trim().split('=')[0])
        .filter(n => /APISID|^SID|^HSID|LOGIN/i.test(n)),
    });
  }

  return { ok: res.ok, status: res.status, json };
}

// Manual debug hooks — paste `_yquDebug.selfTest()` in DevTools console to
// check the auth flow independent of the unsubscribe endpoint.
window._yquDebug = {
  ytCfg, getCookie, buildAuthHeader,
  async selfTest() {
    const r = await ytApiPost('/youtubei/v1/account/account_menu', {});
    console.log('[YQU] self-test result:', r);
    return r;
  },
};

async function resolveChannelId(channelUrl) {
  const direct = channelUrl.match(UC_RE);
  if (direct) return direct[1];

  // /@handle and legacy /user/, /c/ paths — ask Innertube to resolve.
  const { ok, json } = await ytApiPost('/youtubei/v1/navigation/resolve_url', { url: channelUrl });
  if (!ok || !json) return null;
  const ep = json.endpoint ?? json.navigationEndpoint ?? {};
  const id = ep.browseEndpoint?.browseId
          ?? ep.urlEndpoint?.url?.match(UC_RE)?.[1];
  return id?.startsWith('UC') ? id : null;
}

async function unsubscribe(channelUrl, name) {
  const t = newToast();
  t.update(`⏳ ${name}…`);

  try {
    const channelId = await resolveChannelId(channelUrl);
    if (!channelId) {
      t.finish(`❌ ${name}: couldn't resolve channel ID`);
      return false;
    }

    const { ok, status, json } = await ytApiPost('/youtubei/v1/subscription/unsubscribe', {
      channelIds: [channelId],
      params: UNSUB_PARAMS,
    });

    if (!ok) {
      const errMsg = json?.error?.message || `HTTP ${status}`;
      t.finish(`❌ ${name}: ${errMsg}`);
      return false;
    }

    // The endpoint is idempotent — succeeds whether or not you were
    // subscribed, so we can't distinguish "just unsubscribed" from "wasn't
    // subscribed". That's fine; it can't accidentally subscribe.
    t.finish(`✅ Unsubscribed from ${name}`);
    return true;
  } catch(e) {
    console.error('[YQU]', e);
    t.finish(`❌ ${name}: ${e.message || e}`);
    return false;
  }
}

// ─── Inject Unsubscribe button under each video card's channel name ───────────

const CARD_SEL = 'ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-grid-video-renderer';

function addButton(card) {
  if (card.querySelector('.yqu-btn')) return;
  // Skip the watch-page suggestions sidebar — those are mixed with channels
  // the user isn't subscribed to, where the button is just visual clutter.
  // (The API call is idempotent and can never accidentally subscribe, but
  // the button would still light up "Unsubscribed" on non-subbed channels.)
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
    // Lock this card's button immediately so further clicks queue nothing.
    // Other cards' clicks run truly in parallel — each is just an HTTP POST.
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
