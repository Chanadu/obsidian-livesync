# Hourly Raspberry Pi vault backup

This job exports the existing CouchDB Vault into a fresh temporary directory and backs up the resulting files to `Chanadu/obsidian-vault`. It uses the CLI `snapshot` command, which downloads documents and Chunks without registering a device, accepting nodes, changing the remote lock, or writing remote checkpoints. Its HTTP boundary rejects remote writes, including attempts to create missing synchronisation parameters. A missing parameter must be repaired through the ordinary setup workflow before backup can proceed.

Earlier jobs used `fetch --force` in a fresh database each hour. That recovery workflow could register a new randomly identified `server` client on every run. Stop the old timer before installing this version. Existing registrations are not removed automatically; after the old job is stopped, unwanted backup registrations can be forgotten in Obsidian. An old-version notice alone does not establish a synchronisation failure.

## Requirements

- The `pi` user, with home `/home/pi`, Docker, rsync, Python 3, Git, and systemd.
- Docker image `livesync-backup-cli:snapshot-v1`, built from the updated CLI. `LIVESYNC_BACKUP_IMAGE` can select another image which provides `snapshot`.
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

From the existing fork checkout on the Pi:

```bash
git pull --ff-only origin feature/automatic-region-merge
bash utils/pi-vault-backup/install-and-cleanup.sh
```

This builds the new CLI image from the Git checkout, installs the fixed backup scripts, removes accumulated `server` device records, and runs one manual backup. It preserves desktop, mobile, unknown-platform, and current-device records and the remote lock. The timer remains stopped. To install without removing any records, run `bash utils/pi-vault-backup/install-snapshot-fix.sh` instead, then start and inspect the backup service manually.

The installer copies the scripts, including the server-device cleanup helper, into `~/.local/lib/obsidian-vault-backup/` and installs system-wide service and timer units. It does not enable the timer. The service runs as `pi`, with Docker-group access for that service. Files are created with a private umask. Authentication uses the private PAT file created above.

For a supplied `livesync-backup-fix` bundle, run `bash backup-tools/install-snapshot-fix.sh` from its extracted directory instead of rebuilding the repository. This builds a separate image on top of the existing Pi image, retaining its native dependencies and replacing the JavaScript bundle. The old image is retained, and the timer stays stopped. This path requires the previously configured `livesync-backup-cli` image. The installer checks that the new image starts and provides both `snapshot` and `forget-servers`; the manual backup below remains necessary to verify this Pi's connection, encryption, and export.

If server-device removal is intended as well, `bash backup-tools/install-and-cleanup.sh` installs the fix, removes the `server` records with `--force`, and runs one manual backup. It leaves the hourly timer stopped and prints the backup log, including when the test backup fails. It requires a fresh `last-success.txt` marker, so an invocation skipped because another backup holds the lock does not count as a verified backup. This combined command makes the registry changes described below; use the separate preview command first when reviewing the selected records is needed.

To remove accumulated headless backup registrations after installing the new image:

```bash
bash ~/.local/lib/obsidian-vault-backup/cleanup-server-devices.sh
bash ~/.local/lib/obsidian-vault-backup/cleanup-server-devices.sh --force
```

The first command previews the records. The second removes them using LiveSync's conflict-safe joined-device editor. Both commands stop the old backup timer and service, take the backup lock, and use a temporary local database with a private copy of the configured CLI settings. Only records explicitly reported as `server` are selected; the current device, desktop, mobile, and unknown-platform records remain. The command does not delete notes or unlock the remote. It stops on an unsupported edit, or if server records remain or return during cleanup; completed removals remain completed and a later run can continue. Refresh Joined devices in Obsidian afterwards. The timer remains stopped until the new snapshot backup has been verified.

After the manual run succeeds:

```bash
sudo systemctl enable --now obsidian-vault-backup.timer
systemctl list-timers obsidian-vault-backup.timer
```

The timer runs hourly, with up to two minutes of jitter. `Persistent=true` causes one catch-up invocation after missed calendar runs; it does not recreate every missed hourly snapshot. The system service starts independently of SSH logins. Its maximum run time is 50 minutes, and a lock prevents overlapping backup scripts.

## Protections and limits

- Start only with a clean checkout on `main`, and fetch/fast-forward without rebasing or force-pushing.
- Seed a fresh local database from a private copy of the CLI settings for every snapshot. The CLI refuses an existing local database with document history, including tombstones, or a non-empty export directory. Failed or stale local state cannot masquerade as a fresh export.
- Check exported paths and byte sizes against the CLI database listing. Reject missing files, empty snapshots, symbolic links, unresolved conflicts (including logical-deletion winners), and unexpected files before rsync changes the checkout.
- Stop if more than the larger of 20 paths or one quarter of existing tracked paths would disappear. Many deliberate moves can also trigger this guard; review those manually instead of silently bypassing it.
- Exclude `.git`, `.obsidian`, `.livesync`, `.livesync-region-recovery`, `.env*`, `.gitignore`, and `.gitattributes` from export copying. Notes containing secrets are still notes; do not store credentials in the Vault.
- Commit only when content changes, but always attempt a push so a previous failed push can be retried.
- Preserve old Git history; never force-push. A failed post-copy step can leave a dirty checkout, which intentionally blocks later runs until reviewed. A completed local commit whose push failed is retried normally.

The snapshot exports all normal-file Metadata already stored in CouchDB, independently of current sync path filters. The exclusions above still apply when copying into Git; Hidden File Sync and Customisation Sync records are not exported.

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
bash -n utils/pi-vault-backup/backup.sh utils/pi-vault-backup/install.sh utils/pi-vault-backup/install-snapshot-fix.sh
python3 -m unittest discover -s utils/pi-vault-backup -p 'test_*.py' -v
```

Automated checks cover export validation, a local end-to-end Git/rsync harness, and real Git credential requests against the PAT helper. CLI tests cover repeated snapshots with real local databases and decoded text and binary files, unchanged source documents and device records, incomplete content, conflicts, and rejected remote writes. A real scheduled run against this Pi, CouchDB, and GitHub remains a deployment check, completed by the manual first run above.
