#!/usr/bin/env bash
# Generate an internal TLS CA + server certificate for the Paperclip -> Hermes
# gateway hop.
#
# Why: Paperclip refuses to verify (and therefore run) an agent that talks to a
# non-loopback host over plain HTTP. Our Paperclip and Hermes are separate
# containers, so the connection is non-loopback. We terminate HTTPS at the nginx
# proxy in front of the Hermes runs API and have Paperclip trust this CA
# (NODE_EXTRA_CA_CERTS). The cert is valid for the internal hostname
# "hermes-gateway" (an nginx network alias). Everything here is internal to the
# Docker network and is never exposed publicly.
#
# Idempotent: regenerates only when the certs are missing or no longer valid.
set -euo pipefail
cd "$(dirname "$0")/.."

TLS_DIR="data/tls"
CN="hermes-gateway"
ALT="DNS:hermes-gateway,DNS:proxy,DNS:localhost,IP:127.0.0.1"
mkdir -p "$TLS_DIR"

if ! command -v openssl >/dev/null 2>&1; then
  echo "  ! openssl not found; cannot generate gateway TLS certs. Install openssl and re-run." >&2
  exit 1
fi

# Keep existing certs if they are still a valid CA/leaf pair with the right SAN.
if [ -s "$TLS_DIR/ca.crt" ] && [ -s "$TLS_DIR/server.crt" ] && [ -s "$TLS_DIR/server.key" ] \
   && openssl verify -CAfile "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt" >/dev/null 2>&1 \
   && openssl x509 -in "$TLS_DIR/server.crt" -noout -text 2>/dev/null | grep -q "DNS:hermes-gateway"; then
  echo "Gateway TLS certs already present and valid ($TLS_DIR)."
  exit 0
fi

echo "Generating internal gateway TLS CA + server cert in $TLS_DIR ..."
umask 077

# 1) Internal CA (Paperclip trusts this via NODE_EXTRA_CA_CERTS).
openssl genrsa -out "$TLS_DIR/ca.key" 4096 >/dev/null 2>&1
openssl req -x509 -new -nodes -key "$TLS_DIR/ca.key" -sha256 -days 3650 \
  -subj "/O=Suburban Cyber Agent OS/CN=Agent OS Internal CA" \
  -out "$TLS_DIR/ca.crt" >/dev/null 2>&1

# 2) Server key + cert signed by the CA, with SANs for the internal hostname.
openssl genrsa -out "$TLS_DIR/server.key" 2048 >/dev/null 2>&1
openssl req -new -key "$TLS_DIR/server.key" \
  -subj "/O=Suburban Cyber Agent OS/CN=$CN" \
  -out "$TLS_DIR/server.csr" >/dev/null 2>&1
openssl x509 -req -in "$TLS_DIR/server.csr" \
  -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" -CAcreateserial \
  -days 3650 -sha256 \
  -extfile <(printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$ALT") \
  -out "$TLS_DIR/server.crt" >/dev/null 2>&1
rm -f "$TLS_DIR/server.csr"

# nginx (proxy) and Paperclip run as root in-container and mount these read-only,
# so root can always read them; keep the private keys tight on the host anyway.
chmod 644 "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt" 2>/dev/null || true
chmod 600 "$TLS_DIR/ca.key" "$TLS_DIR/server.key" 2>/dev/null || true
echo "Done. Gateway serves HTTPS as '$CN'; Paperclip trusts $TLS_DIR/ca.crt."
