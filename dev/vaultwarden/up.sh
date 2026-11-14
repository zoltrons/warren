#!/usr/bin/env bash
# Starts the local e2e server: Vaultwarden latest on 127.0.0.1:8080 and the mock IdP on :9090, then waits for both.
#   bash dev/vaultwarden/up.sh [--pull]    --pull first moves to a newer :latest image
# Docker (CI): docker compose. Apple `container` (this repo's Macs): the same settings, read from docker-compose.yml.
# `container` cannot share a network namespace, so the IdP gets a container of its own and the server reaches it at
# that container's address (the browser reaches it there too). Both are recreated on every run: the data is test data.
set -euo pipefail
cd "$(dirname "$0")"
pull=$([[ "${1:-}" == --pull ]] && echo 1 || true)
wait_for() {
  for _ in $(seq 60); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "timed out waiting for $1" >&2
  return 1
}

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  [[ -n "$pull" ]] && docker compose pull
  exec docker compose up -d --wait
fi
command -v container >/dev/null || { echo "need docker or Apple container" >&2; exit 1; }
container system status >/dev/null 2>&1 || container system start

vw=docker.io/vaultwarden/server:latest
node=docker.io/library/node:24-alpine
[[ -n "$pull" ]] && { container image pull "$vw"; container image pull "$node"; }
for c in warren-vw warren-idp; do
  container stop "$c" >/dev/null 2>&1 || true
  container delete "$c" >/dev/null 2>&1 || true
done

# Without the IdP (e.g. its image cannot be pulled) the server still starts and the e2e SSO steps are skipped.
ip=localhost
if container run -d --name warren-idp -p 127.0.0.1:9090:9090 -v "$PWD:/idp:ro" "$node" node /idp/mock-idp.mjs >/dev/null; then
  ip=$(container list | awk '$1 == "warren-idp" {sub(/\/.*/, "", $6); print $6}')
  [[ -n $ip ]] && wait_for http://localhost:9090/.well-known/openid-configuration || { ip=localhost; container logs warren-idp >&2 || true; }
fi
if [[ $ip == localhost ]]; then
  echo "warning: mock IdP did not start; the e2e SSO steps will be skipped" >&2
fi

# The compose file's environment block, with the IdP at its container's address.
env=()
while IFS= read -r kv; do env+=(-e "$kv"); done < <(sed -n 's/^      \([A-Z_]*\): "\(.*\)".*/\1=\2/p' docker-compose.yml | sed 's/\${VW_PORT:-8080}/8080/' | grep -v '^SSO_AUTHORITY=')
container run -d --name warren-vw -p 127.0.0.1:8080:80 "${env[@]}" -e "SSO_AUTHORITY=http://$ip:9090" "$vw" >/dev/null
wait_for http://localhost:8080/alive || exit 1
echo "Vaultwarden http://localhost:8080 (warren-vw)$([[ $ip != localhost ]] && echo ", mock IdP http://$ip:9090 (warren-idp)")"
