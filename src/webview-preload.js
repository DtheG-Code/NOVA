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
  // ------------------------------------------------------------------
  const injectMainWorld = (fn) => {
    try {
      const s = document.createElement('script');
      s.textContent = '(' + fn.toString() + ')();';
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { /* noop */ }
  };

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
        const enforce = document.querySelector('ytd-enforcement-message-view-model, tp-yt-paper-dialog');
        if (enforce) {
          const v = document.querySelector('video.html5-main-video');
          if (v && v.paused) { try { v.play(); } catch {} }
          enforce.remove();
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
