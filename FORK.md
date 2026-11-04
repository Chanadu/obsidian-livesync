# Automatic Markdown merge fork

This personal fork of Self-hosted LiveSync preserves independent Markdown edits and automatically chooses newer text inside overlapping regions. It uses original **file** modification times, not per-word edit times. It is experimental and requires testing in disposable Vaults before use with important notes.

## Behaviour

Enable **(Experimental fork) merge Markdown; prefer newer text in overlaps** under advanced Sync Settings → Conflict resolution on every synchronising device. The persisted key remains `resolveConflictsByNewerFile`, but its Markdown behaviour differs from upstream. Turn off **Delay conflict resolution of inactive files**. Use this fork on every device.

- Read the exact available revision histories and find the nearest shared ancestor.
- Merge independent lines, then refine overlapping line blocks into word, whitespace, and punctuation tokens.
- Choose the newer revision only for overlapping token regions. Preserve all other merged regions.
- Break equal modification times by revision ID using code-unit ordering.
- Preserve the newer input's modification time when storing a merged result. A merge is not a new user edit.
- Without a readable shared base, keep the newer whole file. Whole-note deletion versus editing also uses file recency.
- Store both inputs and the proposed result before removing a losing branch.
- If input content, backup storage, or the merged write is unavailable, leave the branches intact and report an operational failure. Do not open a merge-selection dialogue from the automatic Markdown resolver.

Other file types, Hidden File Sync, and Customisation Sync retain upstream policies. This feature does not make every application error or configuration review automatic.

## Recovery copies

Each resolved pair is saved in `.livesync-region-recovery/<identity-hash>.json` inside the Vault on the device performing the merge. The JSON contains the note path, original revision IDs, times, deletion state, both input texts, and the result. These are ordinary local plaintext files, protected like the Vault itself, not encrypted remote objects. They are retained without automatic pruning.

Keep Hidden File Sync and Customisation Sync disabled for the initial setup. If enabling hidden-file synchronisation later, exclude `.livesync-region-recovery/` explicitly. Keep independent Vault backups; these local copies are not a substitute for a backup of every device.

## Limits and validation

Version `1.0.44-chanadu.3` prevents the legacy integrity scan from treating pending note edits or ordinary conflicts as database corruption when the recorded and stored database sizes agree. This update does not enable automatic synchronisation if Sync Mode is disabled. Focused tests cover shorter and longer Vault edits, healthy conflicts, and the retained repair rules for inconsistent database content; real-device update validation remains outstanding.

Version `1.0.44-chanadu.2` fixes recovery-directory creation on fresh Vaults. Earlier builds can leave an otherwise readable conflict unresolved because the recovery file cannot be written. Update the fork, or create `.livesync-region-recovery` directly inside the Vault before retrying the conflict check. The regression test exercises Commonlib's actual directory helper against a temporary filesystem; it does not claim full Obsidian or iOS coverage.

The supported development target is two personal devices: desktop and iOS. The token merge is syntactic; it does not understand Markdown meaning, YAML validity, or the intended meaning of a sentence. Device clock errors can select the wrong text. JSON, Canvas, binary attachments, and settings do not receive token-level merging.

Multiple branches are processed oldest first among those currently visible. Pairwise three-way merging is not associative, and a merged file's timestamp cannot describe the age of each surviving word. Different subsets arriving at different times can therefore affect the result. Region-level operation timestamps or a CRDT would be required for stronger multi-branch guarantees. This fork does not claim those guarantees.

Unit tests cover region selection, equal-time ties, Unicode, CRLF, delete-versus-edit, recovery failures, failed writes, stale leaves, and missing content. A real in-memory PouchDB replication test checks concurrent two-device resolutions, exact revision histories, convergence, and reconstruction of the resolver. That fixture does not exercise Commonlib Chunk encoding, a CouchDB server, Obsidian file reflection, a physical iPhone, or a full application restart.

Before using your main Vault, verify two disposable Obsidian Vaults against a dedicated CouchDB database, including offline edits, app restarts, renames, deletions, and iOS suspension. Those runtime checks remain outstanding until actually run.

## Build and desktop installation

From this repository, with Node.js and npm installed:

```bash
npm ci
npm run test:unit
npm run check
npm run build
```

Install `main.js`, `manifest.json`, and `styles.css` into `<test-vault>/.obsidian/plugins/chanadu-livesync/`. Restart Obsidian and enable **LiveSync Automatic Merge**. Disable the upstream plug-in and any other sync engine in that Vault before enabling this one. The distinct plug-in ID prevents official community updates from replacing the fork.

For iOS distribution, publish those three files as release assets on your fork, then install the fork through a compatible custom plug-in installer. The release upload and iOS installation are separate from a successful local build; no release is published automatically by these instructions. Do not install an upstream release asset accidentally.

## Automatic releases on this fork

Push a new version tag such as `1.0.44-chanadu.3` to `Chanadu/obsidian-livesync` to build and publish its GitHub prerelease automatically. The tagged commit must contain the matching package versions, `manifest.json`, `versions.json`, and a dated release section in `updates.md`. Prepare these with the existing version and release-note scripts before tagging:

```bash
npm version 1.0.44-chanadu.4 --no-git-tag-version
node utils/release-notes.mjs prepare 1.0.44-chanadu.4
# Review and commit the version metadata and release notes, then:
git tag 1.0.44-chanadu.4
git push origin HEAD refs/tags/1.0.44-chanadu.4
```

The `Publish Chanadu Plug-in Release` workflow validates the tag, plug-in identity, and release metadata, runs focused tests, builds the bundle, checks compatibility, and uploads `main.js`, `manifest.json`, and `styles.css`. It publishes only personal fork prereleases, without changing the latest stable release or publishing CLI images. Tag pushes run the workflow from the tagged commit; this does not require the workflow on the default branch. Existing upstream manual release workflows remain available. For this fork, the tag-triggered workflow is the publication route instead of the upstream manual finalisation process. Never move a published tag; prepare a new version for a correction.

In BRAT, select the new version if the plug-in was installed with a specific version. A pinned older version will not advance automatically. Verify installation, start-up, and bidirectional synchronisation on your devices after updating; publication alone does not establish those checks.

## Raspberry Pi and the existing Funnel

First inspect the Pi without changing it:

```bash
uname -m
docker --version
docker compose version
sudo tailscale funnel status
sudo tailscale serve status
```

Use the upstream [Docker server setup](docker/README.md), starting only its default CouchDB services. In `docker/.env`, choose strong credentials and set:

```dotenv
COUCHDB_DATABASE=obsidiannotes_test
COUCHDB_PORT=127.0.0.1:5984
```

Use the Pi's existing host Tailscale installation rather than the bundled Tailscale container profile. Back up the existing Funnel configuration before adding a new endpoint. If HTTPS port **8443 is unused**, add:

```bash
sudo tailscale funnel --bg --https=8443 http://127.0.0.1:5984
sudo tailscale funnel status
```

Then use `https://<pi>.<tailnet>.ts.net:8443` as the CouchDB server URI. If 8443 is already assigned, inspect whether 10000 is available. Do not run Funnel reset or replace the existing 443 endpoint. Test the old service after adding the new endpoint.

Keep authentication required, enable LiveSync end-to-end encryption with a separate passphrase, and check access over cellular data with Tailscale disabled on the phone. iOS must be able to reach the HTTPS endpoint while Obsidian is active; the Pi cannot make a suspended iOS plug-in run continuously.
