#!/usr/bin/env bash
# Regenerates the TLS fixtures used by test/tls.test.ts and test/tls-e2e.test.ts.
#
# The output is committed so CI never needs openssl. Run this only when the
# fixture shape must change (new SAN, new key type, expiry); then commit the
# regenerated files alongside the change.
#
#   ./test/fixtures/ssl/generate.sh
set -euo pipefail

cd "$(dirname "$0")"

DAYS=7300                      # ~20 years: fixtures must not rot the test suite
KEY_BITS=2048
PASSPHRASE=preman-test         # must match CLIENT_KEY_PASSPHRASE in test/helpers.ts

rm -f ./*.crt ./*.key ./*.pem ./*.srl

new_ca() {
  local name=$1 cn=$2
  openssl req -x509 -newkey "rsa:${KEY_BITS}" -nodes -sha256 -days "${DAYS}" \
    -keyout "${name}.key" -out "${name}.crt" \
    -subj "/CN=${cn}" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
}

new_leaf() {
  local name=$1 cn=$2 san=$3 eku=$4 ca=$5
  openssl req -newkey "rsa:${KEY_BITS}" -nodes -sha256 \
    -keyout "${name}.key" -out "${name}.csr" -subj "/CN=${cn}"
  openssl x509 -req -in "${name}.csr" -sha256 -days "${DAYS}" \
    -CA "${ca}.crt" -CAkey "${ca}.key" -CAcreateserial \
    -out "${name}.crt" \
    -extfile <(printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=%s\nsubjectAltName=%s\n' "${eku}" "${san}")
  rm -f "${name}.csr"
}

# Two independent CAs so a test can prove that trusting one does not trust the other.
new_ca ca "preman test CA"
new_ca other-ca "preman other test CA"

# The server the in-process test servers present. Both spellings of loopback are
# covered because gRPC dials an IP authority while HTTP tests use a hostname.
new_leaf server "localhost" "DNS:localhost,IP:127.0.0.1" "serverAuth" ca

# Same CA, deliberately wrong SAN, to exercise the hostname-mismatch hint.
new_leaf wrong-host "wrong.example" "DNS:wrong.example" "serverAuth" ca

# mTLS client identity, plus the variants the flag matrix needs.
new_leaf client "preman test client" "DNS:preman-client" "clientAuth" ca

# Decision 10: --ssl-client-cert alone may hold both halves in one PEM.
cat client.crt client.key > client-combined.pem

# Encrypted counterpart of client.key for --ssl-client-passphrase.
openssl rsa -in client.key -aes256 -passout "pass:${PASSPHRASE}" -out client-encrypted.key

rm -f ./*.srl
echo "regenerated $(ls ./*.crt ./*.key ./*.pem | tr '\n' ' ')"
