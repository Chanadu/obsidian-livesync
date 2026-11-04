#!/usr/bin/env bash
set -euo pipefail
umask 077
export GIT_TERMINAL_PROMPT=0

backup_home="${LIVESYNC_BACKUP_HOME:-$HOME}"
backup_repo="$backup_home/obsidian-vault-backup"
backup_state="$backup_home/livesync-backup-state"
backup_tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_key="$backup_home/.ssh/obsidian-vault-backup"
export GIT_SSH_COMMAND="ssh -i $backup_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes"

for backup_command in docker git rsync python3 flock timeout; do
    command -v "$backup_command" >/dev/null
done
mkdir -p "$backup_state/jobs"
exec 9>"$backup_state/backup.lock"
if ! flock -n 9; then
    echo 'Another vault backup is running; skipping this run.'
    exit 0
fi

[[ -f "$backup_state/.livesync/settings.json" ]]
[[ -f "$backup_key" ]]
[[ "$(git -C "$backup_repo" rev-parse --show-toplevel)" == "$backup_repo" ]]
[[ "$(git -C "$backup_repo" branch --show-current)" == main ]]
[[ "$(git -C "$backup_repo" remote get-url origin)" == git@github.com:Chanadu/obsidian-vault.git ]]
if [[ -n "$(git -C "$backup_repo" status --porcelain)" ]]; then
    echo 'Backup checkout has uncommitted changes; leaving it untouched.' >&2
    exit 1
fi
git -C "$backup_repo" fetch origin main
git -C "$backup_repo" merge --ff-only origin/main

backup_run="$(mktemp -d "$backup_state/jobs/run.XXXXXXXX")"
trap 'rm -rf -- "$backup_run"' EXIT
mkdir -p "$backup_run/db/.livesync" "$backup_run/export"
cp "$backup_state/.livesync/settings.json" "$backup_run/db/.livesync/settings.json"
chmod 600 "$backup_run/db/.livesync/settings.json"
backup_mounts=(--rm --network host --user "$(id -u):$(id -g)"
    -v "$backup_run/db:/data" -v "$backup_run/export:/export")

echo 'Fetching a fresh snapshot from CouchDB...'
# Use a unique container name so interrupted/timed-out jobs can remove it.
backup_container="vault-backup-$(id -u)-$$"
trap 'docker rm -f "$backup_container" >/dev/null 2>&1 || true; rm -rf -- "$backup_run"' EXIT
timeout --signal=TERM --kill-after=30s 2400s docker run \
    --name "$backup_container" "${backup_mounts[@]}" \
    livesync-backup-cli --vault /export fetch --force

timeout --signal=TERM --kill-after=30s 120s docker run --name "$backup_container" "${backup_mounts[@]}" \
    livesync-backup-cli --vault /export ls >"$backup_run/manifest.tsv"

python3 "$backup_tools/verify.py" "$backup_run/manifest.tsv" "$backup_run/export" "$backup_repo"

rsync -rc --delete \
    --exclude='.git/' --exclude='.obsidian/' --exclude='.livesync/' \
    --exclude='.livesync-region-recovery/' --exclude='.env*' \
    --exclude='.gitignore' --exclude='.gitattributes' \
    "$backup_run/export/" "$backup_repo/"

git -C "$backup_repo" add -A
if ! git -C "$backup_repo" diff --cached --quiet; then
    git -C "$backup_repo" -c user.name='Obsidian Pi Backup' \
        -c user.email='Chanadu@users.noreply.github.com' \
        commit -m "Vault backup $(date -u +'%Y-%m-%d %H:%M UTC')"
else
    echo 'No note changes to commit.'
fi
# Always push: this also retries a clean local commit whose earlier push failed.
git -C "$backup_repo" push origin HEAD:main
date -u +'%Y-%m-%dT%H:%M:%SZ' >"$backup_state/last-success.txt"
echo 'Vault backup finished successfully.'
