#!/usr/bin/env bash
set -euo pipefail
backup_tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$backup_tools/install-snapshot-fix.sh"
bash "$backup_tools/cleanup-server-devices.sh" --force
backup_home="${LIVESYNC_BACKUP_HOME:-$HOME}"
backup_success="$backup_home/livesync-backup-state/last-success.txt"
backup_success_before="$(stat -c '%y' "$backup_success" 2>/dev/null || true)"
backup_started="$(date '+%Y-%m-%d %H:%M:%S')"
if ! sudo systemctl start obsidian-vault-backup.service; then
    sudo journalctl -u obsidian-vault-backup.service --since "$backup_started" -n 60 --no-pager
    echo 'The test backup failed. The hourly timer remains stopped.' >&2
    exit 1
fi
sudo journalctl -u obsidian-vault-backup.service --since "$backup_started" -n 60 --no-pager
backup_success_after="$(stat -c '%y' "$backup_success" 2>/dev/null || true)"
if [[ ! -s "$backup_success" || "$backup_success_after" == "$backup_success_before" ]]; then
    echo 'The test did not produce a new successful backup. It may have been skipped; the hourly timer remains stopped.' >&2
    exit 1
fi
echo 'Installation, server-device cleanup, and a manual backup completed. Review the output before enabling the timer.'
