import {
    LiveSyncCouchDBReplicator,
    type OwnedCouchDBConnection,
} from "@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator";
import { REMOTE_COUCHDB, type EntryDoc } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { createBlob, readContent, constructCustomRegExpList } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { stripAllPrefixes } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/path";
import { fsPromises as fs, path } from "@vrtmrz/livesync-commonlib/node";
import type { CLICommandContext } from "./types";
import { ReadOnlyRemoteService } from "@/apps/cli/services/ReadOnlyRemoteService";

/** Bind data operations to the owned handle while keeping task-progress reads local. */
function snapshotReplicationSource(
    connection: OwnedCouchDBConnection<EntryDoc>
): OwnedCouchDBConnection<EntryDoc>["db"] {
    // PouchDB 9 starts an unawaited source.info() after each replication batch.
    // Its completion event can precede those reads, so closing the HTTP handle
    // would abort them and reject a promise outside the replication result.
    // Only the task counters need info(); the changes feed still reads the remote.
    const info = async () => ({ ...connection.info });
    return new Proxy(connection.db, {
        get(target, key) {
            if (key === "info") return info;
            const value = Reflect.get(target, key, target) as unknown;
            return typeof value === "function" ? (value.bind(target) as unknown) : value;
        },
    });
}

/** Download into a disposable database without negotiating membership or writing remote checkpoints. */
export async function snapshotRemote(context: CLICommandContext): Promise<boolean> {
    const { core, vaultPath } = context;
    if (!(core.services.remote instanceof ReadOnlyRemoteService)) {
        throw new Error("Snapshot requires the read-only remote service.");
    }
    const settings = core.services.setting.currentSettings();
    if (settings.remoteType !== REMOTE_COUCHDB) throw new Error("Snapshot requires a CouchDB remote.");
    if ((await fs.readdir(vaultPath)).length !== 0) throw new Error("Snapshot requires an empty export directory.");
    const database = core.services.database.localDatabase;
    const existing = await database.localDatabase.changes({ since: 0, return_docs: true });
    if (existing.results.some((row) => !row.id.startsWith("_design/"))) {
        throw new Error("Snapshot requires a fresh local database.");
    }
    // A private connection performs decryption, but never runs replication preflight,
    // device acceptance, remote locking, or the local reconstruction workflow.
    const replicator = new LiveSyncCouchDBReplicator(core);
    try {
        const connection = await replicator.connectRemoteCouchDBWithSetting(settings, false, false);
        if (typeof connection === "string") throw new Error("Could not open the snapshot connection.");
        try {
            const result = await database.localDatabase.replicate.from(snapshotReplicationSource(connection), {
                checkpoint: false,
                live: false,
                retry: false,
            });
            if (!result.ok || result.errors.length > 0) throw new Error("Snapshot download was incomplete.");
        } finally {
            await connection.close();
        }
        // Snapshot selection comes from the downloaded normal-file Metadata,
        // not the current device's watcher filters. Keep this policy in memory
        // and restore it even when export fails; no settings lifecycle is run.
        const readPolicy = {
            syncInternalFiles: settings.syncInternalFiles,
            syncOnlyRegEx: settings.syncOnlyRegEx,
            syncIgnoreRegEx: settings.syncIgnoreRegEx,
        };
        try {
            await core.services.setting.applyPartial(
                {
                    syncInternalFiles: true,
                    syncOnlyRegEx: constructCustomRegExpList([], "|[]|"),
                    syncIgnoreRegEx: constructCustomRegExpList([], "|[]|"),
                },
                true
            );
            // All Chunks must have arrived in this download. Do not fetch or repair
            // missing content through the active Replicator while exporting.
            let count = 0;
            for await (const doc of database.findAllNormalDocs({ conflicts: true })) {
                if (doc._conflicts?.length) throw new Error("Snapshot contains unresolved note conflicts.");
                if (doc._deleted || doc.deleted) continue;
                const name = stripAllPrefixes(doc.path);
                if (
                    !name ||
                    path.isAbsolute(name) ||
                    /[\\\t\r\n\0]/u.test(name) ||
                    name.split("/").some((part) => !part || part === "." || part === "..")
                )
                    throw new Error("Snapshot contains an unsafe filename.");
                const source = await database.getDBEntryFromMeta(doc, false, false, true);
                if (!source || source.deleted) throw new Error("Snapshot content is unavailable.");
                const bytes = new Uint8Array(await createBlob(readContent(source)).arrayBuffer());
                if (bytes.byteLength !== doc.size)
                    throw new Error("Snapshot content size does not match its Metadata.");
                const destination = path.join(vaultPath, name);
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
                count++;
            }
            if (!count) throw new Error("Snapshot is empty.");
            core.services.context.standardIo.writeStderr(`[Snapshot] Exported ${count} files without remote writes.\n`);
            return true;
        } finally {
            await core.services.setting.applyPartial(readPolicy, true);
        }
    } finally {
        await replicator.closeReplication();
    }
}
