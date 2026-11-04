# Hourly Raspberry Pi vault backup

This job exports the existing CouchDB Vault into a fresh temporary directory and backs up the resulting files to `Chanadu/obsidian-vault`. It uses the Docker image and CLI settings already configured on the Pi. It does not run `mirror`, `daemon`, or `rebuild`. The CLI `fetch` command can update replication administration metadata, but this job does not upload local note edits.

## Requirements

- The `pi` user, with home `/home/pi`, Docker, rsync, Python 3, Git, and systemd.
- Docker image `livesync-backup-cli` already built.
- Working CLI settings at `~/livesync-backup-state/.livesync/settings.json`.
- A clean Git checkout at `~/obsidian-vault-backup`, on `main`.
- A GitHub PAT with write access to `Chanadu/obsidian-vault`.

## Authentication

As `pi`, save the existing PAT using a hidden prompt:

```bash
python3 utils/pi-vault-backup/save-pat.py
```

The PAT is stored in `~/livesync-backup-state/github.pat`, outside the Vault and Git checkout. The file is plaintext with mode `600` in a private directory. Git needs access to it for unattended pushes. A fine-grained PAT requires access to this repository and Contents read/write permission. Renew it here if it expires. Do not put the token in the remote URL, a command argument, or a Vault note.

```bash
git -C ~/obsidian-vault-backup remote set-url origin https://github.com/Chanadu/obsidian-vault.git
```

The job uses a dedicated Git askpass helper over HTTPS, with other credential helpers disabled for its Git commands. The helper only supplies the PAT for GitHub and the expected repository. It refuses insecure token-file permissions. It does not log the PAT or save it in Git configuration. An SSH key is not required.

## Installation and first run

From the updated fork checkout on the Pi:

```bash
bash utils/pi-vault-backup/install.sh
sudo systemctl start obsidian-vault-backup.service
sudo journalctl -u obsidian-vault-backup.service -n 50 --no-pager
```

The installer copies the scripts into `~/.local/lib/obsidian-vault-backup/` and installs system-wide service and timer units. It does not enable the timer. The service runs as `pi`, with Docker-group access for that service. Files are created with a private umask. Authentication uses the private PAT file created above.

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

Automated checks cover export validation, a local end-to-end Git/rsync harness, and real Git credential requests against the PAT helper. A real scheduled run against this Pi, CouchDB, and GitHub remains a deployment check, completed by the manual first run above.
