# Hourly Raspberry Pi vault backup

This job exports the existing CouchDB Vault into a fresh temporary directory and backs up the resulting files to `Chanadu/obsidian-vault`. It uses the Docker image and CLI settings already configured on the Pi. It does not run `mirror`, `daemon`, or `rebuild`. The CLI `fetch` command can update replication administration metadata, but this job does not upload local note edits.

## Requirements

- The `pi` user, with home `/home/pi`, Docker, rsync, Python 3, Git, and systemd.
- Docker image `livesync-backup-cli` already built.
- Working CLI settings at `~/livesync-backup-state/.livesync/settings.json`.
- A clean Git checkout at `~/obsidian-vault-backup`, on `main`.
- A dedicated SSH deploy key with write access to `Chanadu/obsidian-vault`.

## Authentication

As `pi`, create a dedicated key without an interactive passphrase for the unattended job. The existing key is never replaced:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
test -f ~/.ssh/obsidian-vault-backup || ssh-keygen -t ed25519 \
  -f ~/.ssh/obsidian-vault-backup -C 'web-pi vault backup' -N ''
cat ~/.ssh/obsidian-vault-backup.pub
```

Add only the public `.pub` text under the repository's **Settings → Deploy keys**, with **Allow write access** selected. The private file stays on the Pi, outside the Vault and Git checkout.

```bash
ssh -i ~/.ssh/obsidian-vault-backup -o IdentitiesOnly=yes -T git@github.com
git -C ~/obsidian-vault-backup remote set-url origin git@github.com:Chanadu/obsidian-vault.git
```

On first connection, verify GitHub's published host-key fingerprint before accepting it. GitHub's successful SSH test normally exits with status 1 because it does not offer shell access. The job itself uses strict host verification and batch authentication.

## Installation and first run

From the updated fork checkout on the Pi:

```bash
bash utils/pi-vault-backup/install.sh
sudo systemctl start obsidian-vault-backup.service
sudo journalctl -u obsidian-vault-backup.service -n 50 --no-pager
```

The installer copies the scripts into `~/.local/lib/obsidian-vault-backup/` and installs system-wide service and timer units. It does not enable the timer. The service runs as `pi`, with Docker-group access for that service. Files are created with a private umask. No PAT is stored by this job.

After the manual run succeeds:

```bash
sudo systemctl enable --now obsidian-vault-backup.timer
systemctl list-timers obsidian-vault-backup.timer
```

The timer runs hourly, with up to two minutes of jitter. `Persistent=true` causes one catch-up invocation after missed calendar runs; it does not recreate every missed hourly snapshot. The system service starts independently of SSH logins. Its maximum run time is 50 minutes, and a lock prevents overlapping backup scripts.

## Protections and limits

- Start only with a clean checkout on `main`, and fetch/fast-forward without rebasing or force-pushing.
- Seed a fresh local database from a private copy of the CLI settings for every snapshot. Failed or stale local state cannot masquerade as a fresh export.
- Check exported paths and byte sizes against the CLI database listing. Reject missing files, empty snapshots, symbolic links, unresolved conflicts, and unexpected files before rsync changes the checkout.
- Stop if more than the larger of 20 paths or one quarter of existing tracked paths would disappear. Many deliberate moves can also trigger this guard; review those manually instead of silently bypassing it.
- Exclude `.git`, `.obsidian`, `.livesync`, `.livesync-region-recovery`, `.env*`, `.gitignore`, and `.gitattributes` from export copying. Notes containing secrets are still notes; do not store credentials in the Vault.
- Commit only when content changes, but always attempt a push so a previous failed push can be retried.
- Preserve old Git history; never force-push. A failed post-copy step can leave a dirty checkout, which intentionally blocks later runs until reviewed. A completed local commit whose push failed is retried normally.

This is a periodic backup, not an atomic distributed snapshot. Desktop and phone changes which have not reached CouchDB are not included. The CLI export uses the installed version's file-selection and encryption rules. The manifest verifies file presence and size; it is not a second independent cryptographic verification of remote contents.

## Status and maintenance

```bash
sudo journalctl -u obsidian-vault-backup.service --since today --no-pager
cat ~/livesync-backup-state/last-success.txt
sudo systemctl disable --now obsidian-vault-backup.timer
```

Logs are kept in the journal and can contain note paths, but the scripts do not print passwords or Setup URIs. The success marker is updated only after a successful push. There is no external failure notification configured.

Local validation:

```bash
bash -n utils/pi-vault-backup/backup.sh utils/pi-vault-backup/install.sh
python3 -m unittest discover -s utils/pi-vault-backup -p 'test_*.py' -v
```

Automated checks cover export validation and a local end-to-end Git/rsync harness. A real scheduled run against this Pi, CouchDB, and GitHub remains a deployment check, completed by the manual first run above.
