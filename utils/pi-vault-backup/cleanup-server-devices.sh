#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" != 0 ]] || { echo 'Run this script as pi, without sudo.' >&2; exit 1; }
backup_home="${LIVESYNC_BACKUP_HOME:-$HOME}"
backup_state="$backup_home/livesync-backup-state"
backup_image="${LIVESYNC_BACKUP_IMAGE:-livesync-backup-cli:snapshot-v1}"
backup_apply=()
if [[ "${1:-}" == --force && $# == 1 ]]; then
    backup_apply=(--force)
elif [[ $# != 0 ]]; then
    echo 'Usage: cleanup-server-devices.sh [--force] (preview unless --force is supplied)' >&2
    exit 1
fi
sudo systemctl disable --now obsidian-vault-backup.timer
sudo systemctl stop obsidian-vault-backup.service
mkdir -p "$backup_state/jobs"
exec 9>"$backup_state/backup.lock"
flock -n 9 || { echo 'Another backup or cleanup is running.' >&2; exit 1; }
backup_run="$(mktemp -d "$backup_state/jobs/cleanup.XXXXXXXX")"
backup_container="vault-device-cleanup-$(id -u)-$$"
trap 'sudo docker rm -f "$backup_container" >/dev/null 2>&1 || true; rm -rf -- "$backup_run"' EXIT
mkdir -p "$backup_run/db/.livesync" "$backup_run/export"
cp "$backup_state/.livesync/settings.json" "$backup_run/db/.livesync/settings.json"
chmod 600 "$backup_run/db/.livesync/settings.json"
echo 'Reviewing server device registrations; desktop and phone records are preserved...'
sudo docker run --rm --network host --name "$backup_container" \
    --user "$(id -u):$(id -g)" -v "$backup_run/db:/data" -v "$backup_run/export:/export" \
    "$backup_image" --vault /export forget-servers "${backup_apply[@]}"
