import {
    AUTO_MERGED,
    MISSING_OR_ERROR,
    NOT_CONFLICTED,
    type FilePathWithPrefix,
    type LoadedEntry,
    type diff_check_result,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import { getDocData } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import type { LiveSyncLocalDB } from "@vrtmrz/livesync-commonlib/compat/pouchdb/LiveSyncLocalDB";
import type { DatabaseFileAccess } from "@vrtmrz/livesync-commonlib/compat/interfaces/DatabaseFileAccess";
import type { StorageAccess } from "@vrtmrz/livesync-commonlib/compat/interfaces/StorageAccess";
import { compareVersions, mergeRegions } from "./regionMerge";

export const REGION_RECOVERY_DIRECTORY = ".livesync-region-recovery";
export type RevisionMetadata = LoadedEntry & { _revs_info?: { rev: string; status: string }[] };

export interface AutomaticRegionDependencies {
    readonly log?: (message: string) => void;
    readonly localDatabase: () => Pick<LiveSyncLocalDB, "getDBEntryMeta" | "getDBEntry">;
    readonly databaseFileAccess: Pick<DatabaseFileAccess, "storeWithLiveBaseRevision">;
    readonly storageAccess: Pick<StorageAccess, "writeHiddenFileAuto" | "ensureDir">;
    readonly resolveByDeletingRevision: (
        path: FilePathWithPrefix,
        revision: string,
        reason: string
    ) => Promise<typeof AUTO_MERGED | typeof MISSING_OR_ERROR>;
}

function deleted(entry: LoadedEntry): boolean {
    return !!(entry.deleted || entry._deleted);
}

/** Fork-only policy. Read exact histories and write through the public Chunk APIs. */
export function createAutomaticRegionResolver(dependencies: AutomaticRegionDependencies) {
    return async (path: FilePathWithPrefix): Promise<diff_check_result> => {
        const fail = (reason: string): typeof MISSING_OR_ERROR => {
            dependencies.log?.(`Automatic region merge deferred (${reason}): ${path}`);
            return MISSING_OR_ERROR;
        };
        const database = dependencies.localDatabase();
        const current = await database.getDBEntryMeta(path, { conflicts: true }, true);
        if (!current || !current._rev) return fail("current revision unavailable");
        const revisions = [current._rev, ...(current._conflicts ?? [])];
        if (revisions.length < 2) return NOT_CONFLICTED;

        // Read all leaves before changing any branch. Missing bodies are an IO
        // failure, never an invitation to discard an unreadable user's edit.
        const snapshots = await Promise.all(
            revisions.map(async (rev) => {
                const meta: RevisionMetadata | false = await database.getDBEntryMeta(
                    path,
                    { rev, revs_info: true },
                    true
                );
                const body = await database.getDBEntry(path, { rev }, false, false, true, true);
                return meta && body ? { meta, body, rev, data: getDocData(body.data), mtime: body.mtime } : false;
            })
        );
        if (snapshots.some((snapshot) => snapshot === false)) return fail("input revision or local Chunks unavailable");
        const leaves = snapshots.filter((snapshot) => snapshot !== false);
        leaves.sort(compareVersions);
        // Resolve the two oldest branches first; never invent a fresh edit time.
        // Pairwise merges are not a per-region operation history: see fork docs.
        const [left, right] = leaves;
        let result = right.data;
        let hasBase = false;
        if (!deleted(left.body) && !deleted(right.body)) {
            const available = new Set(
                (left.meta._revs_info ?? [])
                    .filter((revision) => revision.status === "available")
                    .map((revision) => revision.rev)
            );
            const common = (right.meta._revs_info ?? [])
                .filter((revision) => revision.status === "available" && available.has(revision.rev))
                .sort((a, b) => Number(b.rev.split("-")[0]) - Number(a.rev.split("-")[0]))[0];
            if (common) {
                const base = await database.getDBEntry(path, { rev: common.rev }, false, false, true, true);
                if (base && !deleted(base)) {
                    hasBase = true;
                    result = mergeRegions(getDocData(base.data), left, right);
                }
            }
        }

        // Keep a durable local copy before the losing leaf is logically deleted.
        // Hash the identity to avoid unsafe paths and leaking note names in paths.
        const identity = JSON.stringify([path, left.rev, right.rev]);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
        const name = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const backup = JSON.stringify({
            format: 1,
            path,
            hasBase,
            left: { rev: left.rev, mtime: left.mtime, deleted: deleted(left.body), data: left.data },
            right: { rev: right.rev, mtime: right.mtime, deleted: deleted(right.body), data: right.data },
            result,
        });
        // Commonlib's ensureDir creates the parent directories of a FILE path.
        // Passing only the directory name silently creates nothing.
        const backupPath = `${REGION_RECOVERY_DIRECTORY}/${name}.json`;
        if (
            !(await dependencies.storageAccess.ensureDir(backupPath)) ||
            !(await dependencies.storageAccess.writeHiddenFileAuto(backupPath, backup))
        ) {
            return fail("recovery copy could not be saved");
        }

        // Recheck the observed leaves; another writer may have advanced a branch
        // while the base or recovery copy was being read/written.
        const latest = await database.getDBEntryMeta(path, { conflicts: true }, true);
        if (!latest) return fail("current revision unavailable during recheck");
        const live = new Set([latest._rev, ...(latest._conflicts ?? [])]);
        if (!live.has(left.rev) || !live.has(right.rev)) return fail("input branches changed; retry after sync");

        if (!deleted(right.body) && result !== right.data) {
            const body = new Blob([result], { type: "text/plain" });
            const stored = await dependencies.databaseFileAccess.storeWithLiveBaseRevision(
                {
                    name: path.split("/").pop()!,
                    path,
                    stat: { type: "file", size: body.size, ctime: right.body.ctime, mtime: right.mtime },
                    body,
                },
                right.rev
            );
            if (!stored) return fail("merged revision could not be stored");
        }
        return await dependencies.resolveByDeletingRevision(path, left.rev, "Automatic region merge");
    };
}
