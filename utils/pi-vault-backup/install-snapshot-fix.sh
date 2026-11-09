#!/usr/bin/env bash
set -euo pipefail
backup_tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_bundle="$(cd -- "$backup_tools/.." && pwd)"
backup_checkout="$(cd -- "$backup_tools/../.." && pwd)"
if [[ -f "$backup_bundle/cli-dist/index.cjs" ]]; then
    backup_build_mode=bundle
elif [[ -f "$backup_checkout/src/apps/cli/Dockerfile" && -f "$backup_checkout/package-lock.json" ]]; then
    backup_build_mode=checkout
else
    echo 'Run this script from the Git checkout or an extracted snapshot-fix bundle.' >&2
    exit 1
fi
sudo systemctl disable --now obsidian-vault-backup.timer
sudo systemctl stop obsidian-vault-backup.service
if [[ "$backup_build_mode" == bundle ]]; then
    sudo docker image inspect livesync-backup-cli >/dev/null
    sudo docker build --pull=false -f "$backup_tools/Dockerfile.snapshot" \
        -t livesync-backup-cli:snapshot-v1 "$backup_bundle"
else
    sudo docker build -f "$backup_checkout/src/apps/cli/Dockerfile" \
        -t livesync-backup-cli:snapshot-v1 "$backup_checkout"
fi
backup_help="$(sudo docker run --rm livesync-backup-cli:snapshot-v1 --help)"
[[ "$backup_help" == *'snapshot '* && "$backup_help" == *'forget-servers '* ]] || {
    echo 'The new image does not provide both snapshot and forget-servers; leaving the timer stopped.' >&2
    exit 1
}
bash "$backup_tools/install.sh"
echo 'Snapshot fix installed. The timer remains stopped. Test one backup before enabling it.'
