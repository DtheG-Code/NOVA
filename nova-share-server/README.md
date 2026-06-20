# NOVA Share — Server

Sicherer Datei-Share-Server für NOVA: Konten, Kontingente, max. Dateigröße, Admin-Verwaltung.

## Schnellster Weg: automatisches Deployment (nginx + HTTPS)
Wenn auf dem Server bereits **nginx** läuft, macht das mitgelieferte Script alles automatisch —
Node-Dienst (systemd), HTTPS-Reverse-Proxy und Firewall, erreichbar unter **https://anonymchat.digital:8787**:
```bash
cd nova-share-server
sudo bash deploy.sh
```
Das Script: installiert Node (falls nötig) + Abhängigkeiten, richtet den systemd-Dienst `nova-share`
(intern auf 127.0.0.1:8790) ein, holt/nutzt das Let's-Encrypt-Zertifikat für die Domain, legt einen
nginx-Server-Block auf Port 8787 (SSL → Proxy) an und gibt den Port frei. Mehrfach ausführbar
(auch für Updates). Andere bestehende nginx-Seiten bleiben unangetastet.
Domain/Ports stehen oben in `deploy.sh` und sind dort anpassbar.

Admin-Passwort nach dem ersten Lauf:
```bash
journalctl -u nova-share | grep -A4 'Admin-Konto'
```

---

## Voraussetzung (manueller Weg)
Node.js ≥ 18 auf dem Server.

## Installation & Start
```bash
cd nova-share-server
npm install
npm start
```
Beim **ersten Start** wird ein Admin-Konto angelegt und das Passwort **einmalig** im Log ausgegeben — sofort notieren.
Alternativ vorgeben:
```bash
ADMIN_USER=damian ADMIN_PASS='EinStarkesPasswort!' npm start
```

Standard-Port **8787** (änderbar via `PORT=9000 npm start` oder in `data/config.json`).

## Dauerbetrieb (empfohlen: systemd oder pm2)
```bash
npm i -g pm2
pm2 start server.js --name nova-share
pm2 save && pm2 startup
```

## HTTPS (WICHTIG für den Produktivbetrieb)
Passwörter und Dateien laufen über die Leitung — **nie ohne TLS** ins Internet.
Zwei Wege:

**A) Reverse-Proxy (empfohlen)** — z. B. Caddy:
```
share.deinedomain.de {
    reverse_proxy localhost:8787
}
```
oder nginx mit `proxy_pass http://localhost:8787;` hinter einem Let's-Encrypt-Zertifikat.

**B) Direkt im Server:**
```bash
TLS_CERT=/pfad/fullchain.pem TLS_KEY=/pfad/privkey.pem npm start
```

## In NOVA verbinden
NOVA → Topbar → **Share**-Icon → Server-Adresse eintragen (z. B. `https://share.deinedomain.de`
oder `http://192.168.1.50:8787` im LAN) → mit Konto anmelden.
Meldet sich ein **Admin** an, erscheint in NOVA automatisch der **Admin-Tab** (Konten anlegen, Kontingente/Max-Dateigröße setzen, sperren/löschen).

## Daten
Alles liegt unter `data/`:
- `data/users.json` — Konten (Passwörter sind bcrypt-Hashes)
- `data/files.json` — Datei-Metadaten
- `data/files/<id>` — die eigentlichen Dateien
- `data/config.json` — Port, JWT-Secret, Standard-Kontingente

**Backup** = Ordner `data/` sichern. `data/` niemals öffentlich/versioniert machen (siehe `.gitignore`).

## Sicherheit – Kurzfassung
- Passwörter: bcrypt (Cost 12). JWT-Auth (Bearer), Secret in `data/config.json`.
- Upload prüft **max. Dateigröße** und **Kontingent** (auch mitten im Stream).
- Admin-Endpunkte nur mit Admin-Rolle. Login mit Brute-Force-Bremse.
- Dateien werden unter zufälliger ID gespeichert (kein Pfad-Traversal über Dateinamen).
