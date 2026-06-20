'use strict';
// Läuft in jedem Webview. Exponiert die Nova-API NUR auf internen nova://-Seiten.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'nova:') {
  contextBridge.exposeInMainWorld('novaPage', {
    getData: () => ipcRenderer.invoke('newtab:data'),
    suggest: (q) => ipcRenderer.invoke('newtab:suggest', q),
    addDial: (d) => ipcRenderer.invoke('newtab:addDial', d),
    removeDial: (d) => ipcRenderer.invoke('newtab:removeDial', d),
    onDials: (cb) => ipcRenderer.on('newtab:dials', (_e, dials) => cb(dials)),
    onAccent: (cb) => ipcRenderer.on('newtab:accent', (_e, d) => cb(d)),
    onPlugins: (cb) => ipcRenderer.on('newtab:plugins', (_e, d) => cb(d)),
    onNebula: (cb) => ipcRenderer.on('newtab:nebula', (_e, d) => cb(d)),
    // Agent-Modus: Suchbegriff als Ziel an den Browser (Host-Renderer) → NOVA Operator
    agent: (goal) => ipcRenderer.sendToHost('nova-agent', goal),
  });
} else {
  // Auf normalen Webseiten den Ghostery-Cosmetic-Filter aktivieren:
  // versteckt Werbeflächen/Banner direkt im DOM (Element-Hiding, Scriptlets,
  // erweiterte Selektoren). Das ergänzt das Netzwerk-Blocking deutlich.
  try {
    require('@ghostery/adblocker-electron-preload');
  } catch (err) {
    // Adblock-Cosmetic-Preload optional — Browser läuft auch ohne weiter
    console.debug('[nova] cosmetic preload unavailable:', err && err.message);
  }

  // ------------------------------------------------------------------
  // Code in die MAIN WORLD der Seite einschleusen (der Preload läuft isoliert,
  // kann window.fetch der Seite also nicht direkt überschreiben).
  // WICHTIG: Seiten wie YouTube/Spotify erzwingen Trusted Types — eine direkte
  // String-Zuweisung an script.textContent wirft „requires 'TrustedScript'".
  // Daher eine TrustedTypes-Policy nutzen (mit Fallbacks), sonst scheitert das
  // Ad-Stripping → YouTube wartet auf geblockte Werbung → Video stockt.
  // ------------------------------------------------------------------
  let __ttPolicy = null;
  try {
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      __ttPolicy = window.trustedTypes.createPolicy('nova-inject', { createScript: (s) => s });
    }
  } catch (e) { __ttPolicy = null; }
  const injectMainWorld = (fn) => {
    const code = '(' + fn.toString() + ')();';
    const s = document.createElement('script');
    try {
      s.text = __ttPolicy ? __ttPolicy.createScript(code) : code;
    } catch (e) {
      try { s.text = code; } catch (e2) { try { s.textContent = code; } catch (e3) { return; } }
    }
    try { (document.head || document.documentElement).appendChild(s); s.remove(); } catch (e) { /* noop */ }
  };

  // ------------------------------------------------------------------
  // Google/YouTube-Consent-Seite automatisch wegklicken (sonst hängt YouTube Music
  // im Musik-Player auf der Zustimmungsseite). Reject bevorzugt (Datenschutz),
  // sonst Accept — beides leitet zur Seite weiter.
  // ------------------------------------------------------------------
  if (/(^|\.)consent\.(youtube|google)\.com$/.test(location.hostname)) {
    const passConsent = () => {
      try {
        const rejectRx = /^(alle ablehnen|reject all|tout refuser|rechazar todo|alles afwijzen)$/i;
        const acceptRx = /^(alle akzeptieren|accept all|ich stimme zu|i agree|zustimmen|tout accepter|aceptar todo)$/i;
        const btns = document.querySelectorAll('button, [role="button"], input[type="submit"]');
        let accept = null;
        for (const b of btns) {
          const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim();
          if (rejectRx.test(t)) { b.click(); return true; }
          if (!accept && acceptRx.test(t)) accept = b;
        }
        if (accept) { accept.click(); return true; }
      } catch (_) {}
      return false;
    };
    let n = 0;
    const iv = setInterval(() => { if (passConsent() || ++n > 25) clearInterval(iv); }, 350);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', passConsent, { once: true });
    else passConsent();
  }

  // ------------------------------------------------------------------
  // Chrome Web Store: „In NOVA installieren"-Button auf Erweiterungs-Seiten.
  // So kann der Nutzer im echten Store suchen/stöbern und mit einem Klick
  // direkt in NOVA installieren — ohne Links/IDs manuell zu kopieren.
  // ------------------------------------------------------------------
  if (/(^|\.)chromewebstore\.google\.com$/.test(location.hostname) || (location.hostname === 'chrome.google.com' && /\/webstore\//.test(location.pathname))) {
    const idFromUrl = () => { const m = location.pathname.match(/\/detail\/[^/]+\/([a-p]{32})/i) || location.pathname.match(/([a-p]{32})/i); return m ? m[1].toLowerCase() : null; };
    let btn = null;
    const ensureBtn = () => {
      const id = idFromUrl();
      if (!id) { if (btn) btn.style.display = 'none'; return; }
      if (!btn) {
        btn = document.createElement('button');
        btn.textContent = '➕  In NOVA installieren';
        btn.style.cssText = 'position:fixed;right:22px;bottom:22px;z-index:2147483647;padding:13px 20px;border:none;border-radius:13px;background:linear-gradient(135deg,#f471b5,#7c3aed);color:#fff;font:700 14px system-ui,Segoe UI,sans-serif;cursor:pointer;box-shadow:0 10px 34px rgba(124,58,237,.55);transition:transform .15s,box-shadow .2s';
        btn.onmouseenter = () => { btn.style.transform = 'translateY(-2px)'; };
        btn.onmouseleave = () => { btn.style.transform = 'none'; };
        btn.onclick = () => {
          const cur = idFromUrl(); if (!cur) return;
          try { ipcRenderer.send('plugins:installFromPage', cur); } catch (e) {}
          btn.textContent = '⏳  Wird in NOVA installiert …'; btn.disabled = true; btn.style.opacity = '.85';
          setTimeout(() => { btn.textContent = '✓  In NOVA — fertig'; }, 2600);
          setTimeout(() => { btn.textContent = '➕  In NOVA installieren'; btn.disabled = false; btn.style.opacity = '1'; }, 5200);
        };
        const mount = () => { if (document.body && !btn.isConnected) document.body.appendChild(btn); };
        if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
      }
      btn.style.display = 'block';
    };
    let lastHref = '';
    const tick = () => { if (location.href !== lastHref) { lastHref = location.href; ensureBtn(); } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureBtn, { once: true });
    else ensureBtn();
    setInterval(tick, 700); // SPA-Navigation des Stores abfangen
  }

  // ------------------------------------------------------------------
  // NOVA-Plugins + Userscripts (vom Plugin-Store gesteuert).
  // Aktive Konfiguration synchron beim Seitenstart abholen.
  // ------------------------------------------------------------------
  (function applyPlugins() {
    let cfg = null;
    try { cfg = ipcRenderer.sendSync('plugins:getActive'); } catch (e) { /* noop */ }
    if (!cfg) return;
    const nat = cfg.native || {};

    const addStyle = (css) => {
      const apply = () => {
        try {
          const st = document.createElement('style');
          st.setAttribute('data-nova-plugin', '1');
          st.textContent = css;
          (document.head || document.documentElement).appendChild(st);
        } catch (_) {}
      };
      if (document.documentElement) apply();
      else document.addEventListener('readystatechange', apply, { once: true });
    };
    const onReady = (cb) => {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', cb, { once: true });
      else cb();
    };

    // --- HTTPS erzwingen (vor allem anderen) ---
    if (nat.autohttps && location.protocol === 'http:' && !/^(localhost|127\.|0\.0\.0\.0|\[)/.test(location.hostname)) {
      try {
        const key = 'nova-https-' + location.host;
        if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, '1'); location.replace(location.href.replace(/^http:/, 'https:')); return; }
      } catch (_) {}
    }

    // --- Dunkelmodus erzwingen (Invert), aber NUR auf hellen Seiten ---
    // WICHTIG: Bei filter auf <html> malt Chromium den html-Hintergrund INNERHALB des
    // Filters → ein dunkler Hintergrund würde zu hell invertiert. Daher WEISS setzen.
    // Bereits dunkle Seiten werden erkannt (Hintergrund-Helligkeit) und NICHT invertiert,
    // sonst würden sie fälschlich hell. Kurzes Aufblitzen auf Dark-Sites ist der Kompromiss.
    if (nat.darkmode) {
      const ST_ID = 'nova-darkmode';
      const css = `html{background:#ffffff !important;min-height:100vh;filter:invert(0.92) hue-rotate(180deg) !important}
        img,video,picture,canvas,svg,iframe,[style*="background-image"],[style*="background-img"]{filter:invert(1) hue-rotate(180deg) !important}`;
      const ensure = () => {
        if (document.getElementById(ST_ID)) return;
        try {
          const st = document.createElement('style');
          st.id = ST_ID; st.setAttribute('data-nova-plugin', '1'); st.textContent = css;
          (document.head || document.documentElement).appendChild(st);
        } catch (_) {}
      };
      if (document.documentElement) ensure(); else document.addEventListener('readystatechange', ensure, { once: true });

      // Helligkeit des echten Seiten-Hintergrunds messen (vom Filter unbeeinflusst).
      const lumOf = (c) => {
        const m = /rgba?\(([^)]+)\)/.exec(c || '');
        if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        if (p.length >= 4 && p[3] === 0) return null; // transparent → unbestimmt
        return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
      };
      const reconsider = () => {
        try {
          if (!document.body) return;
          let lum = lumOf(getComputedStyle(document.body).backgroundColor);
          if (lum === null) lum = lumOf(getComputedStyle(document.documentElement).backgroundColor);
          // Schon dunkel? → eigenes Dunkeldesign der Seite behalten, nicht invertieren.
          if (lum !== null && lum < 0.5) { const st = document.getElementById(ST_ID); if (st) st.remove(); }
          else ensure();
        } catch (_) {}
      };
      const onReadyDM = () => { reconsider(); setTimeout(reconsider, 400); setTimeout(reconsider, 1200); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReadyDM, { once: true });
      else onReadyDM();
    }

    // --- Rechtsklick / Markieren / Kopieren erzwingen ---
    if (nat.unblock) {
      ['contextmenu', 'copy', 'cut', 'selectstart', 'dragstart', 'mousedown', 'mouseup'].forEach((ev) => {
        document.addEventListener(ev, (e) => { e.stopImmediatePropagation(); }, true);
      });
      addStyle('*{user-select:text !important;-webkit-user-select:text !important;-webkit-touch-callout:default !important}');
      onReady(() => { try { document.oncontextmenu = null; document.body && (document.body.oncontextmenu = null); } catch (_) {} });
    }

    // --- Cookie-Banner automatisch wegklicken ---
    if (nat.cookiekill) {
      injectMainWorld(function () {
        const RX = /(accept|agree|allow|zustimmen|akzeptieren|einverstanden|alle annehmen|verstanden|ich stimme|got it|i agree|allow all|accept all)/i;
        const kill = () => {
          const sel = '[id*="cookie" i] button, [class*="cookie" i] button, [id*="consent" i] button, [class*="consent" i] button, [aria-label*="accept" i], [data-testid*="accept" i], button';
          let nodes;
          try { nodes = document.querySelectorAll(sel); } catch (_) { return; }
          for (const b of nodes) {
            const t = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim();
            if (t && t.length < 40 && RX.test(t)) { try { b.click(); } catch (_) {} return; }
          }
          // große fixe Overlays mit Cookie-Text entfernen
          document.querySelectorAll('div,section,aside').forEach((el) => {
            try {
              const cs = getComputedStyle(el);
              if ((cs.position === 'fixed' || cs.position === 'sticky') && +cs.zIndex >= 1000 &&
                  el.offsetHeight > 60 && /cookie|consent|datenschutz|privacy|gdpr|dsgvo/i.test(el.className + ' ' + el.id)) {
                el.remove(); document.documentElement.style.overflow = '';
              }
            } catch (_) {}
          });
        };
        let n = 0; const iv = setInterval(() => { kill(); if (++n > 12) clearInterval(iv); }, 700);
        document.addEventListener('DOMContentLoaded', kill, { once: true });
      });
    }

    // --- Video-Geschwindigkeit per Tastatur (S langsamer, D schneller, R zurück) ---
    if (nat.videospeed) {
      injectMainWorld(function () {
        const vid = () => document.querySelector('video');
        let badge;
        const show = (txt) => {
          if (!badge) {
            badge = document.createElement('div');
            badge.style.cssText = 'position:fixed;top:14px;left:14px;z-index:2147483647;background:rgba(10,10,20,.85);color:#fff;font:600 13px system-ui;padding:6px 11px;border-radius:8px;backdrop-filter:blur(8px);box-shadow:0 4px 20px rgba(0,0,0,.5);transition:opacity .3s;pointer-events:none';
            document.documentElement.appendChild(badge);
          }
          badge.textContent = txt; badge.style.opacity = '1';
          clearTimeout(badge._t); badge._t = setTimeout(() => { badge.style.opacity = '0'; }, 1200);
        };
        document.addEventListener('keydown', (e) => {
          if (/input|textarea|select/i.test((e.target && e.target.tagName) || '') || e.target.isContentEditable) return;
          const v = vid(); if (!v) return;
          const k = e.key.toLowerCase();
          if (k === 'd') { v.playbackRate = Math.min(16, v.playbackRate + 0.25); show('▶ ' + v.playbackRate.toFixed(2) + '×'); }
          else if (k === 's') { v.playbackRate = Math.max(0.25, v.playbackRate - 0.25); show('▶ ' + v.playbackRate.toFixed(2) + '×'); }
          else if (k === 'r') { v.playbackRate = 1; show('▶ 1.00×'); }
          else if (k === 'x') { v.currentTime += 10; }
          else if (k === 'z') { v.currentTime -= 10; }
        }, true);
      });
    }

    // --- „Nach oben"-Button ---
    if (nat.scrolltop) {
      onReady(function () {
        const btn = document.createElement('div');
        btn.textContent = '↑';
        btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;width:42px;height:42px;border-radius:50%;background:rgba(124,77,255,.92);color:#fff;font:700 20px system-ui;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 24px rgba(124,77,255,.5);opacity:0;transition:opacity .25s,transform .15s;pointer-events:none';
        btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.1)'; });
        btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1)'; });
        btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
        document.body.appendChild(btn);
        const upd = () => { const on = window.scrollY > 600; btn.style.opacity = on ? '1' : '0'; btn.style.pointerEvents = on ? 'auto' : 'none'; };
        window.addEventListener('scroll', upd, { passive: true }); upd();
      });
    }

    // --- Userscripts (wie Tampermonkey): bei passendem URL-Muster einschleusen ---
    const scripts = cfg.userscripts || [];
    if (scripts.length) {
      const toRx = (pat) => {
        if (!pat || pat === '*' || pat === '<all_urls>') return /.*/;
        try { return new RegExp('^' + pat.trim().split(/\s+/)[0].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'); }
        catch (_) { return /.*/; }
      };
      const href = location.href;
      for (const us of scripts) {
        const pats = (us.matches || '*').split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
        const hit = pats.length === 0 || pats.some((p) => toRx(p).test(href));
        if (!hit) continue;
        try {
          const s = document.createElement('script');
          s.textContent = '(function(){try{\n' + us.code + '\n}catch(e){console.error("[NOVA Userscript]",e)}})();';
          const run = () => { (document.head || document.documentElement).appendChild(s); };
          if (document.documentElement) run();
          else document.addEventListener('readystatechange', run, { once: true });
        } catch (_) {}
      }
    }
  })();

  // ------------------------------------------------------------------
  // YouTube: Werbung an der QUELLE entfernen → kein 30-Sekunden-Stau mehr.
  // Statt Ad-Requests zu blockieren (worauf der Player wartet), säubern wir
  // die Player-Antwort (/youtubei/v1/player & /next) direkt: ohne adPlacements
  // lädt YouTube gar keine Werbung und löst auch keinen Anti-Adblock aus.
  // ------------------------------------------------------------------
  if (/(^|\.)youtube\.com$/.test(location.hostname) || location.hostname === 'youtu.be') {
    injectMainWorld(function () {
      const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'];
      const stripAds = (data) => {
        if (!data || typeof data !== 'object') return data;
        for (const k of AD_KEYS) { if (k in data) try { delete data[k]; } catch (_) {} }
        // „Adblock erkannt"-Sperre neutralisieren
        if (data.playabilityStatus && data.playabilityStatus.status &&
            data.playabilityStatus.status !== 'OK' &&
            /AdBlock|ad blocker|werbeblocker/i.test(JSON.stringify(data.playabilityStatus) || '')) {
          data.playabilityStatus = { status: 'OK', playableInEmbed: true };
        }
        return data;
      };
      const isPlayerReq = (url) => typeof url === 'string' &&
        /\/youtubei\/v1\/(player|next|reel_item_watch|get_watch)/.test(url);

      // fetch() abfangen (der moderne YouTube-Client nutzt fetch)
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const promise = origFetch.apply(this, arguments);
        if (!isPlayerReq(url)) return promise;
        return promise.then((resp) => {
          if (!resp || !resp.ok) return resp;
          return resp.clone().text().then((txt) => {
            try {
              const data = stripAds(JSON.parse(txt));
              return new Response(JSON.stringify(data), {
                status: resp.status, statusText: resp.statusText, headers: resp.headers,
              });
            } catch (_) { return resp; }
          }).catch(() => resp);
        });
      };

      // XHR-Fallback (ältere Pfade / Polymer)
      const origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__novaPlayer = isPlayerReq(url);
        return origOpen.apply(this, arguments);
      };
      const origGetter = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
      // responseText/respose lassen wir, der fetch-Pfad deckt YouTube ab.

      // ytInitialPlayerResponse (erste Seitenladung) ebenfalls säubern
      try {
        let cached;
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
          configurable: true,
          get() { return cached; },
          set(v) { cached = stripAds(v); },
        });
      } catch (_) {}
    });

    // Schlanker Fallback: falls doch mal eine Werbung durchrutscht, sofort
    // überspringen. Läuft selten (nur bei aktiver Werbung), kostet kaum CPU.
    const runYouTubeGuard = () => {
      const skipAds = () => {
        const player = document.querySelector('.html5-video-player');
        if (player && player.classList.contains('ad-showing')) {
          const video = document.querySelector('video.html5-main-video, video');
          if (video && isFinite(video.duration) && video.duration > 0) {
            try { video.currentTime = video.duration; } catch {}
            try { video.muted = true; } catch {}
          }
          const skip = document.querySelector(
            '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-container button'
          );
          if (skip) skip.click();
        }
        // NUR die echte „Adblocker erkannt"-Sperre entfernen — NICHT generische
        // tp-yt-paper-dialog (die nutzt YouTube auch für Menüs/Teilen → würde UI zerstören).
        const enforce = document.querySelector('ytd-enforcement-message-view-model');
        if (enforce) {
          const v = document.querySelector('video.html5-main-video');
          if (v && v.paused) { try { v.play(); } catch {} }
          const dlg = enforce.closest('tp-yt-paper-dialog') || enforce;
          dlg.remove();
        }
      };
      setInterval(() => { try { skipAds(); } catch {} }, 600);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runYouTubeGuard, { once: true });
    } else {
      runYouTubeGuard();
    }
  }
}
