#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=/home/ubuntu/captianmuqimcp
BRANCH=main
IMAGE_REPO=ghcr.io/jaiaaryan/captianmuqimcp
HEALTH_URL=http://127.0.0.1:4001/health
KEEP_IMAGES=3
HEALTH_WAIT=240

log() { printf '[deploy %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "FATAL: $*" >&2; exit 1; }

prune_old_images() {
  sudo docker images "$IMAGE_REPO" --format '{{.CreatedAt}}\t{{.ID}}' \
    | sort -r | awk -F'\t' '!seen[$2]++ {print $2}' \
    | tail -n +"$((KEEP_IMAGES + 1))" \
    | xargs -r sudo docker rmi -f >/dev/null 2>&1 || true
}

main() {
  set -f
  local argv=(${SSH_ORIGINAL_COMMAND:-$*})
  set +f
  [[ "${argv[0]:-}" == "deploy" ]] || die "usage: deploy <tag> <ghcr-user>; got '${SSH_ORIGINAL_COMMAND:-$*}'"
  local tag="${argv[1]:-}" user="${argv[2]:-}"
  [[ "$tag"  =~ ^[A-Za-z0-9._-]{1,128}$ ]] || die "bad image tag"
  [[ "$user" =~ ^[A-Za-z0-9._-]{1,64}$  ]] || die "bad ghcr user"
  local image="$IMAGE_REPO:$tag"

  local token=""
  IFS= read -r token || true
  [[ -n "$token" ]] || die "no GHCR token on stdin"

  cd "$REPO_DIR"
  GIT_TERMINAL_PROMPT=0 git fetch -q origin "$BRANCH"
  git merge -q --ff-only "origin/$BRANCH" || die "server checkout diverged from origin/$BRANCH; fix by hand"
  local head; head="$(git rev-parse --short=7 HEAD)"
  [[ "$tag" == "sha-$head" ]] || log "WARN: image tag $tag != HEAD $head (a newer push probably follows)"
  log "deploying $image (HEAD $head)"

  ln -sfn deploy/self/docker-compose.self.yml docker-compose.override.yml
  if grep -q '^APP_TAG=' .env; then sed -i "s|^APP_TAG=.*|APP_TAG=$tag|" .env; else printf 'APP_TAG=%s\n' "$tag" >> .env; fi

  printf '%s\n' "$token" | sudo docker login ghcr.io -u "$user" --password-stdin >/dev/null
  trap 'sudo docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
  sudo docker compose pull -q app
  sudo docker logout ghcr.io >/dev/null 2>&1 || true
  trap - EXIT

  sudo docker compose up -d --no-build

  local waited=0
  until curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; do
    if (( waited >= HEALTH_WAIT )); then
      sudo docker compose logs --no-color --tail=80 app >&2 || true
      die "backend not healthy after ${HEALTH_WAIT}s"
    fi
    sleep 5; waited=$((waited + 5))
  done
  log "healthy after ~${waited}s"
  sudo docker compose ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}'
  prune_old_images
  log "done"
}

main "$@"
