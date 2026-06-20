#!/usr/bin/env bash
#
# NOVA Share — automatisches Deployment
# Macht NOVA Share unter  https://anonymchat.digital:8787  erreichbar:
#   - Node-Dienst via systemd (intern auf 127.0.0.1:8790)
#   - nginx-Reverse-Proxy mit HTTPS auf Port 8787
#   - Let's-Encrypt-Zertifikat (vorhandenes wird genutzt, sonst via certbot geholt)
#   - Firewall-Freigabe
#
# Auf dem SERVER ausführen (im Ordner nova-share-server):
#   sudo bash deploy.sh
#
# Mehrfach ausführbar (idempotent). Re-Deploy nach Code-Update:  sudo bash deploy.sh
#
set -euo pipefail

# ===================== Einstellungen =====================
DOMAIN="anonymchat.digital"
PUBLIC_PORT="8787"      # öffentlich erreichbar (HTTPS über nginx)
NODE_PORT="8790"        # intern (Node, nur localhost)
EMAIL="damian.geulebert@spark-radiance.eu"   # für Let's Encrypt
SERVICE="nova-share"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${SUDO_USER:-root}"
# =========================================================

bold(){ printf '\033[1m%s\033[0m\n' "$*"; }
info(){ printf '\033[36m• %s\033[0m\n' "$*"; }
ok(){   printf '\033[32m✓ %s\033[0m\n' "$*"; }
err(){  printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || { err "Bitte mit sudo bzw. als root ausführen:  sudo bash deploy.sh"; exit 1; }
command -v nginx >/dev/null 2>&1 || { err "nginx nicht gefunden. Bitte zuerst nginx installieren."; exit 1; }

bold "NOVA Share → https://$DOMAIN:$PUBLIC_PORT"
info "App-Verzeichnis : $APP_DIR"
info "Dienst-Benutzer : $SERVICE_USER"

# --- 1) Node.js sicherstellen ---
if ! command -v node >/dev/null 2>&1; then
  info "Node.js wird installiert (NodeSource 20.x) …"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
ok "Node $(node -v)"

# --- 2) Abhängigkeiten ---
info "Installiere Abhängigkeiten (npm) …"
( cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund )
mkdir -p "$APP_DIR/data"
chown -R "$SERVICE_USER" "$APP_DIR/data" 2>/dev/null || true
ok "Abhängigkeiten installiert"

# --- 3) systemd-Dienst (Node intern auf 127.0.0.1:NODE_PORT) ---
info "Richte systemd-Dienst '$SERVICE' ein …"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=NOVA Share file server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=$NODE_PORT
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 1
if systemctl is-active --quiet "$SERVICE"; then ok "Dienst läuft (127.0.0.1:$NODE_PORT)"; else err "Dienst startet nicht. Logs:  journalctl -u $SERVICE -e"; exit 1; fi

# --- 4) TLS-Zertifikat ---
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
if [ -f "$CERT_DIR/fullchain.pem" ]; then
  ok "Vorhandenes Zertifikat für $DOMAIN wird genutzt"
else
  info "Kein Zertifikat für $DOMAIN — hole eins via certbot …"
  command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx
  if ! certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --no-eff-email; then
    err "certbot ist fehlgeschlagen."
    err "Prüfe:  (a) $DOMAIN zeigt per A-Record auf diesen Server,  (b) Port 80 ist erreichbar."
    err "Danach erneut ausführen:  sudo bash deploy.sh"
    exit 1
  fi
  ok "Zertifikat ausgestellt"
fi

# --- 5) nginx-Reverse-Proxy auf PUBLIC_PORT ---
info "Schreibe nginx-Konfiguration …"
if [ -d /etc/nginx/sites-available ]; then
  NGINX_TARGET="/etc/nginx/sites-available/$SERVICE.conf"; NGINX_SYMLINK=1
else
  NGINX_TARGET="/etc/nginx/conf.d/$SERVICE.conf"; NGINX_SYMLINK=0
fi
cat > "$NGINX_TARGET" <<EOF
# NOVA Share — HTTPS-Reverse-Proxy (Port $PUBLIC_PORT -> Node 127.0.0.1:$NODE_PORT)
server {
    listen $PUBLIC_PORT ssl;
    listen [::]:$PUBLIC_PORT ssl;
    server_name $DOMAIN;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # grosse Uploads + Streaming (keine Pufferung, kein Groessenlimit)
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;

    location / {
        proxy_pass http://127.0.0.1:$NODE_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
EOF
if [ "$NGINX_SYMLINK" = "1" ]; then ln -sf "$NGINX_TARGET" "/etc/nginx/sites-enabled/$SERVICE.conf"; fi
nginx -t
systemctl reload nginx
sleep 1
# Sicherstellen, dass Port PUBLIC_PORT wirklich gebunden ist (reload bindet keinen Port, der beim ersten
# Mal noch belegt war). Node läuft jetzt intern auf NODE_PORT, also ist PUBLIC_PORT frei.
if command -v ss >/dev/null 2>&1 && ! ss -ltnH 2>/dev/null | grep -q ":$PUBLIC_PORT "; then
  info "Port $PUBLIC_PORT noch nicht gebunden — starte nginx neu …"
  systemctl restart nginx
fi
ok "nginx aktiv auf Port $PUBLIC_PORT (HTTPS)"

# --- 6) Firewall ---
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PUBLIC_PORT"/tcp >/dev/null 2>&1 || true
  ok "Firewall (ufw): Port $PUBLIC_PORT freigegeben"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PUBLIC_PORT"/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "Firewall (firewalld): Port $PUBLIC_PORT freigegeben"
else
  info "Keine aktive ufw/firewalld erkannt — ggf. Port $PUBLIC_PORT manuell/bei deinem Hoster freigeben."
fi

echo
bold "============================================================"
ok   "Fertig!  →  https://$DOMAIN:$PUBLIC_PORT"
echo "  Admin-Passwort (nur beim allerersten Start):"
echo "     journalctl -u $SERVICE | grep -A4 'Admin-Konto'"
echo "  In NOVA:  Share-Icon → Server: https://$DOMAIN:$PUBLIC_PORT → anmelden"
echo "  Dienst-Status:  systemctl status $SERVICE     Logs:  journalctl -u $SERVICE -f"
bold "============================================================"
