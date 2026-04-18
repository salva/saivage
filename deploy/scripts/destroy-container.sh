#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-saivage}"

if ! sudo lxc-info -n "$CONTAINER_NAME" &>/dev/null; then
    echo "Container '${CONTAINER_NAME}' does not exist."
    exit 0
fi

echo "This will permanently delete container '${CONTAINER_NAME}' and all its data."
read -rp "Are you sure? [y/N] " confirm
if [[ "$confirm" != [yY] ]]; then
    echo "Aborted."
    exit 0
fi

echo "==> Stopping container '${CONTAINER_NAME}'..."
sudo lxc-stop -n "$CONTAINER_NAME" -k 2>/dev/null || true

echo "==> Destroying container '${CONTAINER_NAME}'..."
sudo lxc-destroy -n "$CONTAINER_NAME"

echo "==> Done."
