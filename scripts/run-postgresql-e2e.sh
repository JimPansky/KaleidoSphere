#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose_file="$repo_dir/tests/fixtures/postgresql-e2e/compose.yaml"
image_ref='docker.io/library/postgres@sha256:94f23d40fdaf5e60cb2fd8a98c22f02a7b8724949f310d95a0ddf075e8c8b208'
nonce="$(openssl rand -hex 6)"
project="ks23-e2e-$nonce"
port="$(node -e "const net=require('node:net');const server=net.createServer();server.listen({host:'127.0.0.1',port:0},()=>{const port=server.address().port;server.close(()=>process.stdout.write(String(port)));});")"
[[ "$port" =~ ^[0-9]+$ ]]
[[ "$port" != 18789 && "$port" != 8000 && "$port" != 8081 ]]
export KS23_HOST_PORT="$port"
state_dir="$(mktemp -d "$repo_dir/.runtime/ks23-state.XXXXXX")"
secret_dir="$(mktemp -d "$repo_dir/.runtime/ks23-secret.XXXXXX")"
owner_password_file="$secret_dir/owner-password"
scan_password_1_file="$secret_dir/scan-password-1"
scan_password_2_file="$secret_dir/scan-password-2"
cleanup_done=0

[[ "$project" =~ ^ks23-e2e-[a-z0-9-]+$ ]]
[[ "$state_dir" == "$repo_dir"/.runtime/ks23-state.* ]]
[[ "$secret_dir" == "$repo_dir"/.runtime/ks23-secret.* ]]

cleanup() {
  local status=$?
  if [[ "$cleanup_done" -eq 0 ]]; then
    cleanup_done=1
    if docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | grep -q .; then
      KS23_OWNER_PASSWORD_FILE="$owner_password_file" docker compose -p "$project" -f "$compose_file" down --volumes --remove-orphans --timeout 10 >/dev/null
    fi
    rm -rf -- "$secret_dir"
  fi
  return "$status"
}
finalize() {
  local status=$?
  cleanup
  if [[ -d "$state_dir" && "$state_dir" == "$repo_dir"/.runtime/ks23-state.* ]]; then
    rm -rf -- "$state_dir"
  fi
  return "$status"
}
trap finalize EXIT INT TERM

printf 'KS23_OWNER_%s\n' "$(openssl rand -hex 24)" >"$owner_password_file"
printf 'KS23_CRED_CANARY_%s\n' "$(openssl rand -hex 20)" >"$scan_password_1_file"
printf 'KS23_ROTATED_%s\n' "$(openssl rand -hex 22)" >"$scan_password_2_file"
chmod 0600 "$owner_password_file" "$scan_password_1_file" "$scan_password_2_file"

docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' | sort >"$state_dir/containers.before"
docker network ls --no-trunc --format '{{.ID}}\t{{.Name}}' | sort >"$state_dir/networks.before"
docker volume ls --format '{{.Driver}}\t{{.Name}}' | sort >"$state_dir/volumes.before"
systemctl --user show openclaw-gateway.service -p ActiveState -p SubState -p MainPID >"$state_dir/gateway.before"

docker pull --platform linux/amd64 "$image_ref" >/dev/null
KS23_OWNER_PASSWORD_FILE="$owner_password_file" docker compose -p "$project" -f "$compose_file" config --quiet
KS23_OWNER_PASSWORD_FILE="$owner_password_file" docker compose -p "$project" -f "$compose_file" up -d --wait --wait-timeout 90

container_id="$(KS23_OWNER_PASSWORD_FILE="$owner_password_file" docker compose -p "$project" -f "$compose_file" ps -q postgres)"
[[ "$container_id" =~ ^[a-f0-9]{12,64}$ ]] || { printf 'KS23_CONTAINER_ID_INVALID_LENGTH:%s\n' "${#container_id}" >&2; exit 1; }
configured_image="$(docker inspect --format '{{.Config.Image}}' "$container_id")"
[[ "$configured_image" == "postgres@sha256:94f23d40fdaf5e60cb2fd8a98c22f02a7b8724949f310d95a0ddf075e8c8b208" \
  || "$configured_image" == "$image_ref" ]] || { printf 'KS23_IMAGE_BINDING_INVALID:%s\n' "$configured_image" >&2; exit 1; }
published="$(docker inspect --format '{{with index .NetworkSettings.Ports "5432/tcp"}}{{(index . 0).HostIp}}:{{(index . 0).HostPort}}{{end}}' "$container_id")"
[[ "$published" == 127.0.0.1:* ]] || { printf 'KS23_LOOPBACK_BIND_INVALID:%s\n' "$published" >&2; exit 1; }
[[ "${published##*:}" == "$port" ]] || { printf 'KS23_DYNAMIC_PORT_BINDING_MISMATCH\n' >&2; exit 1; }

npm --prefix "$repo_dir/services/bi-control" ci --ignore-scripts --no-audit --no-fund >/dev/null
KS23_POSTGRES_PORT="$port" \
KS23_OWNER_PASSWORD_FILE="$owner_password_file" \
KS23_SCAN_PASSWORD_1_FILE="$scan_password_1_file" \
KS23_SCAN_PASSWORD_2_FILE="$scan_password_2_file" \
KS23_RUNTIME_DIRECTORY="$state_dir/runtime" \
node "$repo_dir/scripts/run-postgresql-e2e.mjs" >"$state_dir/summary.json"

cleanup
docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}' | sort >"$state_dir/containers.after"
docker network ls --no-trunc --format '{{.ID}}\t{{.Name}}' | sort >"$state_dir/networks.after"
docker volume ls --format '{{.Driver}}\t{{.Name}}' | sort >"$state_dir/volumes.after"
systemctl --user show openclaw-gateway.service -p ActiveState -p SubState -p MainPID >"$state_dir/gateway.after"

cmp -s "$state_dir/containers.before" "$state_dir/containers.after"
cmp -s "$state_dir/networks.before" "$state_dir/networks.after"
cmp -s "$state_dir/volumes.before" "$state_dir/volumes.after"
cmp -s "$state_dir/gateway.before" "$state_dir/gateway.after"
! docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | grep -q .
! docker network ls --filter "label=com.docker.compose.project=$project" --format '{{.ID}}' | grep -q .
! docker volume ls --filter "label=com.docker.compose.project=$project" --format '{{.Name}}' | grep -q .
[[ ! -e "$secret_dir" ]]

container_count="$(wc -l <"$state_dir/containers.before")"
network_count="$(wc -l <"$state_dir/networks.before")"
volume_count="$(wc -l <"$state_dir/volumes.before")"
containers_sha256="$(sha256sum "$state_dir/containers.before" | cut -d' ' -f1)"
networks_sha256="$(sha256sum "$state_dir/networks.before" | cut -d' ' -f1)"
volumes_sha256="$(sha256sum "$state_dir/volumes.before" | cut -d' ' -f1)"
gateway_sha256="$(sha256sum "$state_dir/gateway.before" | cut -d' ' -f1)"
cleanup_target="$repo_dir/docs/evidence/postgresql-e2e/cleanup.json"
cleanup_temporary="$(mktemp "$repo_dir/docs/evidence/postgresql-e2e/.cleanup.XXXXXX")"
printf '{"gateway":{"active":true,"inventorySha256":"%s","unchanged":true},"ownedResources":{"containers":0,"networks":0,"volumes":0},"preexistingInventory":{"containerCount":%s,"containersSha256":"%s","networkCount":%s,"networksSha256":"%s","unchanged":true,"volumeCount":%s,"volumesSha256":"%s"},"schemaVersion":"kaleidosphere.db/postgresql-e2e-cleanup/v1","secretDirectoryAbsent":true}\n' \
  "$gateway_sha256" "$container_count" "$containers_sha256" "$network_count" "$networks_sha256" "$volume_count" "$volumes_sha256" >"$cleanup_temporary"
chmod 0600 "$cleanup_temporary"
sync "$cleanup_temporary"
mv -f -- "$cleanup_temporary" "$cleanup_target"

cat "$state_dir/summary.json"
printf '%s\n' '{"cleanup":{"ownedContainers":0,"ownedNetworks":0,"ownedVolumes":0,"secretDirectoryAbsent":true},"preexistingDockerInventoryUnchanged":true,"gatewayUnchanged":true}'
rm -rf -- "$state_dir"
