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
    // ---- NOVA Studio (contained VM) ----
    studioList: () => ipcRenderer.invoke('studio:list'),
    studioSave: (meta, state) => ipcRenderer.invoke('studio:save', meta, state),
    studioLoad: (id) => ipcRenderer.invoke('studio:load', id),
    studioDelete: (id) => ipcRenderer.invoke('studio:delete', id),
    studioImage: (os) => ipcRenderer.invoke('studio:image', os),
    studioDownload: (os) => ipcRenderer.invoke('studio:download', os),
    studioState: (os) => ipcRenderer.invoke('studio:state', os),
    onStudioProgress: (cb) => ipcRenderer.on('studio:progress', (_e, p) => cb(p)),
    studioCmd: (cmd) => ipcRenderer.sendToHost('studio-cmd', cmd),   // Panel-Befehle (split/close) an den Host
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
  // Google/YouTube-Login-Fix: navigator.userAgentData in der MAIN WORLD auf sauberes
  // Chrome setzen (passend zum gespooften UA). Sonst sieht Googles Sign-in-JS hier
  // weiterhin die Marke "Electron" → "Browser nicht unterstützt/sicher".
  // ------------------------------------------------------------------
  injectMainWorld(function () {
    try {
      var m = navigator.userAgent.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
      if (!m) return;
      var major = m[1];
      var full = m[1] + '.' + m[2] + '.' + m[3] + '.' + m[4];
      var brands = [
        { brand: 'Not.A/Brand', version: '24' },
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major }
      ];
      var fullList = [
        { brand: 'Not.A/Brand', version: '24.0.0.0' },
        { brand: 'Chromium', version: full },
        { brand: 'Google Chrome', version: full }
      ];
      var data = {
        brands: brands,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: function () {
          return Promise.resolve({
            architecture: 'x86', bitness: '64', brands: brands, mobile: false,
            model: '', platform: 'Windows', platformVersion: '15.0.0',
            uaFullVersion: full, fullVersionList: fullList
          });
        },
        toJSON: function () { return { brands: brands, mobile: false, platform: 'Windows' }; }
      };
      try { Object.defineProperty(navigator, 'userAgentData', { get: function () { return data; }, configurable: true }); } catch (e) {}
      try { Object.defineProperty(navigator, 'webdriver', { get: function () { return false; }, configurable: true }); } catch (e) {}
    } catch (e) {}
  });

  // ------------------------------------------------------------------
  // NOVA Discord: Call-Status auslesen (in Sprachkanal? welcher? mit wem?) und an den Host melden,
  // damit die eingeklappte Rand-Leiste das anzeigt. Best-Effort über stabile Klassen-Präfixe.
  // ------------------------------------------------------------------
  if (/(^|\.)discord\.com$/.test(location.hostname)) {
    let last = '';
    const readCall = () => {
      let inCall = false, channel = '', people = [];
      try {
        const panel = document.querySelector('[class*="rtcConnectionStatus"]');
        const discBtn = document.querySelector('button[aria-label*="Disconnect" i], button[aria-label*="trennen" i], button[aria-label*="Verbindung trennen" i]');
        inCall = !!panel || !!discBtn;
        if (inCall) {
          const root = (panel && panel.closest('section, [class*="panels"], [class*="wrapper"]')) || document;
          const lines = root.querySelectorAll('[class*="subtext"], [class*="channel"], [class*="title"], [class*="rtcConnectionStatus"] + * *');
          for (const l of lines) { const t = (l.textContent || '').trim(); if (t && t.length < 42 && !/connect|verbind|voice|sprach|stimme|stumm|signal/i.test(t)) { channel = t; break; } }
          document.querySelectorAll('[class*="voiceUser"] img[alt], [class*="voiceUser"] [class*="username"], [class*="participantsWrapper"] [class*="username"]').forEach((u) => {
            const n = (u.getAttribute('alt') || u.textContent || '').trim();
            if (n && people.length < 16 && !people.includes(n)) people.push(n);
          });
        }
      } catch (e) {}
      const j = JSON.stringify({ inCall, channel, people });
      if (j !== last) { last = j; try { ipcRenderer.sendToHost('discord-call', { inCall, channel, people }); } catch (e) {} }
    };
    setInterval(readCall, 2500);
    setTimeout(readCall, 1500);
  }

  // ------------------------------------------------------------------
  // NOVA Vault — Login-Felder erkennen + animiert ausfüllen.
  // Inline-Chip in einem GESCHLOSSENEN Shadow-DOM (von der Seite weder lesbar noch stylebar).
  // Passwörter kommen erst auf Klick vom Hauptprozess und werden hier nur ins Feld getippt.
  // ------------------------------------------------------------------
  (function novaVaultAutofill() {
    const origin = location.origin || (location.protocol + '//' + location.host);
    let matches = [];            // vom Host: [{id,title,username}] — NIE Passwörter
    let groups = [];             // erkannte Login-Gruppen [{user,pass,form}]
    let activeGroup = null, chipAnchor = null, chipHost = null, chipRoot = null, chipVisible = false, chipHovered = false;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    function setNativeValue(el, value) {
      try { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); if (d && d.set) d.set.call(el, value); else el.value = value; }
      catch { try { el.value = value; } catch (e) {} }
    }
    function isVisible(el) { try { const r = el.getBoundingClientRect(); return r.width > 24 && r.height > 8 && r.bottom > 0 && r.right > 0; } catch { return false; } }

    function findGroups() {
      const out = [];
      const pws = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
      for (const pass of pws) {
        const scope = pass.form || pass.closest('form') || document;
        const cands = Array.from(scope.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input:not([type])')).filter(isVisible);
        let user = null;
        for (const c of cands) { if (c !== pass && (pass.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_PRECEDING)) user = c; }  // letztes Feld vor dem Passwort
        if (!user && cands.length) user = cands[cands.length - 1];
        out.push({ user, pass, form: pass.form || pass.closest('form') });
      }
      return out;
    }
    function refresh() {
      groups = findGroups();
      try { ipcRenderer.sendToHost('vault-detect', { origin, hasLogin: groups.length > 0 }); } catch (e) {}
      if (!groups.length) hideChip();
    }

    // ---- Animiertes Tippen ins Feld (Glow + zeichenweise, framework-kompatibel) ----
    async function typeInto(el, value) {
      if (!el) return;
      try { el.focus(); } catch (e) {}
      const prev = el.style.boxShadow, prevT = el.style.transition;
      el.style.transition = 'box-shadow .18s ease';
      el.style.boxShadow = '0 0 0 2px rgba(124,140,255,.95), 0 0 22px rgba(124,140,255,.6)';
      setNativeValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const step = value.length > 28 ? 6 : 14;
      for (let i = 0; i < value.length; i++) {
        setNativeValue(el, value.slice(0, i + 1));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        await sleep(step);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      setTimeout(() => { el.style.boxShadow = prev; el.style.transition = prevT; }, 700);
    }
    async function fillActive(data) {
      const g = activeGroup || groups[0]; if (!g || !data) return;
      hideChip();
      if (g.user && data.username) { await typeInto(g.user, data.username); await sleep(90); }
      if (g.pass && data.password != null) await typeInto(g.pass, String(data.password));
    }
    function requestFill(id) { try { ipcRenderer.sendToHost('vault-fill-request', { id, origin }); } catch (e) {} }

    // ---- Inline-Chip (Shadow-DOM) ----
    function ensureChip() {
      if (chipHost) return;
      chipHost = document.createElement('div');
      chipHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:-9999px;left:-9999px;';
      chipRoot = chipHost.attachShadow({ mode: 'closed' });
      chipRoot.innerHTML =
        '<style>'
        + ':host{all:initial}*{box-sizing:border-box;font-family:Inter,Segoe UI,system-ui,sans-serif}'
        + '.wrap{width:268px;border-radius:14px;overflow:hidden;opacity:0;transform:translateY(-6px) scale(.98);transition:opacity .16s,transform .16s;'
        + 'background:linear-gradient(165deg,rgba(18,17,34,.98),rgba(8,8,16,.99));border:1px solid rgba(124,140,255,.42);'
        + 'box-shadow:0 24px 60px rgba(0,0,0,.6),0 0 40px rgba(124,140,255,.22);backdrop-filter:blur(20px)}'
        + '.wrap.on{opacity:1;transform:none}'
        + '.hd{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.07)}'
        + '.orb{width:20px;height:20px;border-radius:6px;background:linear-gradient(150deg,#5865f2,#9b8cff);box-shadow:0 0 14px rgba(124,140,255,.6);flex:none}'
        + '.hd b{color:#fff;font-size:12px;font-weight:700;letter-spacing:.3px}.hd span{color:#9aa0c0;font-size:10px;margin-left:auto}'
        + '.list{max-height:230px;overflow-y:auto;padding:6px}'
        + '.row{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 9px;border:0;border-radius:9px;background:transparent;cursor:pointer;color:#e8e9ff;transition:background .12s}'
        + '.row:hover{background:rgba(124,140,255,.16)}'
        + '.key{width:26px;height:26px;border-radius:7px;flex:none;display:flex;align-items:center;justify-content:center;background:rgba(124,140,255,.18)}'
        + '.key svg{width:15px;height:15px;stroke:#aab2ff;fill:none;stroke-width:2}'
        + '.tx{display:flex;flex-direction:column;min-width:0}.tx b{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '.tx i{font-size:11px;color:#9aa0c0;font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '</style>'
        + '<div class="wrap"><div class="hd"><span class="orb"></span><b>NOVA Tresor</b><span>automatisch ausfüllen</span></div><div class="list"></div></div>';
      const wrap = chipRoot.querySelector('.wrap');
      wrap.addEventListener('mouseenter', () => { chipHovered = true; });
      wrap.addEventListener('mouseleave', () => { chipHovered = false; });
      document.documentElement.appendChild(chipHost);
    }
    function renderChip() {
      if (!chipRoot) return;
      const keySvg = '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/></svg>';
      chipRoot.querySelector('.list').innerHTML = matches.map((m) =>
        '<button class="row" data-id="' + esc(m.id) + '"><span class="key">' + keySvg + '</span>'
        + '<span class="tx"><b>' + esc(m.title || origin) + '</b><i>' + esc(m.username || '—') + '</i></span></button>').join('');
      chipRoot.querySelectorAll('.row').forEach((b) => b.addEventListener('click', () => requestFill(b.getAttribute('data-id'))));
    }
    function positionChip() {
      if (!chipHost || !chipAnchor) return;
      const r = chipAnchor.getBoundingClientRect();
      chipHost.style.top = Math.max(8, Math.min(window.innerHeight - 80, r.bottom + 6)) + 'px';
      chipHost.style.left = Math.max(8, Math.min(window.innerWidth - 276, r.left)) + 'px';
    }
    function showChip() {
      if (!matches.length) return;
      ensureChip(); renderChip(); positionChip();
      const wrap = chipRoot.querySelector('.wrap');
      requestAnimationFrame(() => wrap.classList.add('on'));
      chipVisible = true;
    }
    function hideChip() {
      if (!chipHost || !chipVisible) return;
      const wrap = chipRoot && chipRoot.querySelector('.wrap'); if (wrap) wrap.classList.remove('on');
      chipHost.style.top = '-9999px'; chipVisible = false;
    }

    // ---- Host → Preload ----
    ipcRenderer.on('vault-offer', (_e, data) => { matches = (data && data.matches) || []; if (chipVisible) renderChip(); });
    ipcRenderer.on('vault-do-fill', (_e, data) => { fillActive(data); });
    ipcRenderer.on('vault-clear', () => { matches = []; hideChip(); });

    // ---- Feld-Fokus → Chip zeigen ----
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!t || !t.matches || !t.matches('input')) return;
      const g = groups.find((x) => x.user === t || x.pass === t);
      if (g && matches.length) { activeGroup = g; chipAnchor = t; showChip(); }
    }, true);
    document.addEventListener('focusout', () => { setTimeout(() => { if (!chipHovered) hideChip(); }, 200); }, true);
    window.addEventListener('scroll', () => { if (chipVisible) positionChip(); }, true);
    window.addEventListener('resize', () => { if (chipVisible) positionChip(); });

    // ---- Neue Zugangsdaten zum Speichern anbieten (Submit / Enter im Passwortfeld) ----
    function offerSave(form) {
      const g = groups.find((x) => x.form === form) || groups.find((x) => x.pass && form && form.contains && form.contains(x.pass)) || groups[0];
      if (!g || !g.pass) return;
      const password = g.pass.value || '';
      if (!password) return;
      try { ipcRenderer.sendToHost('vault-save-offer', { origin, url: location.href, title: document.title, username: g.user ? g.user.value : '', password }); } catch (e) {}
    }
    document.addEventListener('submit', (e) => offerSave(e.target), true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('input[type="password"]')) {
        const g = groups.find((x) => x.pass === e.target); if (g) offerSave(g.form);
      }
    }, true);

    // ---- Start + SPA-Beobachtung ----
    let moTimer = null;
    try {
      const mo = new MutationObserver(() => { clearTimeout(moTimer); moTimer = setTimeout(refresh, 600); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(refresh, 400));
    else setTimeout(refresh, 400);
  })();

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
