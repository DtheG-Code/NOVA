# NOVA Browser

Ein futuristischer, dunkler Browser auf Electron-Basis — mit Glassmorphism/Nebula-Design,
starkem Adblock, Spaces, Split View, integriertem Musik-Player (Spotify & Apple Music),
Netzwerk-Monitor, Download-Manager mit Tempolimit und Auto-Updater.

![NOVA](docs/icon.png)

## Features

- 🎨 **Nebula-Design** — animierte Menüs, Akzentfarben (Standard: Magenta), Hyperraum-Sprung beim Laden
- 🧭 **Tab-Leiste oben oder seitlich** (Standard: oben, mit animiertem Nebula)
- 🛡️ **NOVA Shield** — Adblock + Tracking-Schutz (AdGuard/EasyList/uBlock-Listen, Cookie-Banner)
- 🪟 **Spaces, Split View, angepinnte Tabs, Tab-Vorschauen**
- 🎵 **NOVA Sound** — Spotify & Apple Music eingebettet (Widevine-DRM), Mini-Player in der Topbar
- 📊 **Netzwerk-Monitor** — Live-Bandbreite pro Tab
- ⬇️ **Download-Manager** — Pause/Resume, Gesamt- & Einzel-Tempolimit
- 🔄 **Auto-Updater** — prüft GitHub-Releases, aktualisiert nur nach Zustimmung
- ⭐ **Edge-Favoriten-Import**, Ordner per Drag & Drop

## Starten (Entwicklung)

```bash
npm install            # lädt das castLabs-Electron (mit Widevine)
npm run fonts          # lädt die Schriftarten lokal (einmalig)
npm start
```

> **Hinweis Widevine:** Für Spotify/Apple Music wird das **castLabs-Electron** (`+wvcus`)
> verwendet. Falls `npm install` den Binär-Download nicht abschließt, lade die ZIP einmalig
> direkt und entpacke sie nach `node_modules/electron/dist` (siehe `docs/INSTALL.md`).

## Musik-Wiedergabe aktivieren (VMP-Signatur)

Spotify & Apple Music verlangen eine **produktive Widevine-Signatur**. Einmalig:

```bash
# kostenloses castLabs-Konto
python -m castlabs_evs.account signup
# App signieren
npm run sign
```

## Release bauen (portabel, Windows)

```bash
npm run dist
```

Erzeugt `release/NOVA/` mit `NOVA.exe` (startklar, inkl. Widevine-Signatur) und eine ZIP.

## Lizenz

MIT
