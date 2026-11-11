#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || ! $1 =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Usage: sudo bash deploy-ubuntu.sh <commit-sha> <artifact-directory>' >&2
  exit 2
fi

revision=$1
artifact=$(realpath "$2")
cd /opt/helpdesk
exec 9>.deploy.lock
flock -n 9

(cd "$artifact" && sha256sum --check --status helpdesk-image.tar.gz.sha256)
docker load --input "$artifact/helpdesk-image.tar.gz"
docker image inspect "helpdesk:$revision" >/dev/null

candidate=$(mktemp -p . .compose-candidate.XXXXXX)
trap 'rm -f -- "$candidate"' EXIT
printf 'services:\n  helpdesk:\n    image: helpdesk:%s\n' "$revision" > "$candidate"
compose=(docker compose -f compose.yaml -f "$candidate")

# Report pending migrations before replacing the running container.
"${compose[@]}" run --rm --no-deps helpdesk \
  npm exec --prefix server -- prisma migrate status --schema server/prisma/schema.prisma

healthy() {
  for attempt in {1..20}; do
    if curl --silent --fail --max-time 2 http://127.0.0.1:4000/api/health | grep -qx '{"ok":true}'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if "${compose[@]}" up -d --no-deps --no-build helpdesk && healthy; then
  mv -- "$candidate" compose.override.yaml
  echo "Deployed helpdesk:$revision"
else
  echo 'Candidate failed. Restoring the previous image.' >&2
  docker compose up -d --no-deps --no-build helpdesk
  healthy
  exit 1
fi
