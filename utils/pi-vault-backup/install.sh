#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" != 0 ]] || { echo 'Run this installer as pi, without sudo.' >&2; exit 1; }
[[ "$(id -un)" == pi ]] || { echo 'This installer is configured for the pi user.' >&2; exit 1; }
getent group docker >/dev/null
backup_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_install="$HOME/.local/lib/obsidian-vault-backup"
mkdir -p "$backup_install"
install -m 700 "$backup_source/backup.sh" "$backup_install/backup.sh"
install -m 600 "$backup_source/verify.py" "$backup_install/verify.py"
install -m 700 "$backup_source/git-askpass.py" "$backup_install/git-askpass.py"
install -m 700 "$backup_source/cleanup-server-devices.sh" "$backup_install/cleanup-server-devices.sh"

backup_units="$(mktemp -d)"
trap 'rm -rf -- "$backup_units"' EXIT
cat >"$backup_units/obsidian-vault-backup.service" <<EOF
[Unit]
Description=Export LiveSync notes and back them up to GitHub
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
User=pi
SupplementaryGroups=docker
WorkingDirectory=$HOME
UMask=0077
ExecStart=$backup_install/backup.sh
TimeoutStartSec=50min
EOF
cat >"$backup_units/obsidian-vault-backup.timer" <<'EOF'
[Unit]
Description=Back up the Obsidian vault hourly

[Timer]
OnCalendar=hourly
Persistent=true
RandomizedDelaySec=2min
Unit=obsidian-vault-backup.service

[Install]
WantedBy=timers.target
EOF
sudo install -m 644 "$backup_units/obsidian-vault-backup.service" /etc/systemd/system/
sudo install -m 644 "$backup_units/obsidian-vault-backup.timer" /etc/systemd/system/
sudo systemctl daemon-reload
echo 'Installed. Run save-pat.py if needed and test one backup before enabling the hourly timer.'
