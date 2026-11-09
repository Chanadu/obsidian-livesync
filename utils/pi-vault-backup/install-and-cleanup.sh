#!/usr/bin/env bash
set -euo pipefail
backup_tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
bash "$backup_tools/install-snapshot-fix.sh"
bash "$backup_tools/cleanup-server-devices.sh" --force
backup_started="$(date '+%Y-%m-%d %H:%M:%S')"
if ! sudo systemctl start obsidian-vault-backup.service; then
    sudo journalctl -u obsidian-vault-backup.service --since "$backup_started" -n 60 --no-pager
    echo 'The test backup failed. The hourly timer remains stopped.' >&2
    exit 1
fi
sudo journalctl -u obsidian-vault-backup.service --since "$backup_started" -n 60 --no-pager
echo 'Installation, server-device cleanup, and a manual backup completed. Review the output before enabling the timer.'
