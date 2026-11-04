import PouchDB from "pouchdb-core";
import memory from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";
import { describe, expect, it } from "vitest";
import {
    AUTO_MERGED,
    MISSING_OR_ERROR,
    type LoadedEntry,
    type FilePathWithPrefix,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import { createAutomaticRegionResolver, type AutomaticRegionDependencies } from "./automaticRegionResolution";

PouchDB.plugin(memory).plugin(replication);

interface StoredNote {
    path: string;
    mtime: number;
    ctime: number;
    children: string[];
    deleted?: boolean;
}

/** A real revision-tree/replication fixture; Chunk encoding and Obsidian IO are not exercised here. */
function peer() {
    const db = new PouchDB<StoredNote>(crypto.randomUUID(), { adapter: "memory" });
    const chunks = new Map<string, string>();
    const backups = new Map<string, string>();
    const path = "note.md" as FilePathWithPrefix;
    const loadMeta = async (_path: unknown, options?: PouchDB.Core.GetOptions) => {
        const doc = await db.get(path, options);
        return { ...doc, datatype: "plain", type: "plain", data: "" } as unknown as LoadedEntry;
    };
    const load = async (_path: unknown, options?: PouchDB.Core.GetOptions) => {
        const meta = await loadMeta(path, options);
        const doc = await db.get(path, options);
        const data = chunks.get(doc.children[0]);
        return data === undefined ? false : { ...meta, data };
    };
    const save = async (text: string, mtime: number, parent?: string) => {
        const chunk = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
            (byte) => byte.toString(16).padStart(2, "0")
        ).join("");
        chunks.set(chunk, text);
        return await db.put({
            _id: path,
            ...(parent ? { _rev: parent } : {}),
            path,
            mtime,
            ctime: 1,
            children: [chunk],
        });
    };
    const dependencies = {
        localDatabase: () => ({ getDBEntryMeta: loadMeta, getDBEntry: load }),
        databaseFileAccess: {
            storeWithLiveBaseRevision: async (file, parent) => {
                try {
                    const current = await db.get(path, { rev: parent, conflicts: true });
                    const latest = await db.get(path, { conflicts: true });
                    if (![latest._rev, ...(latest._conflicts ?? [])].includes(current._rev)) return false;
                    return (await save(await file.body.text(), file.stat.mtime, parent)).rev;
                } catch {
                    return false;
                }
            },
        },
        storageAccess: {
            ensureDir: async () => true,
            writeHiddenFileAuto: async (name, data) => {
                backups.set(name, String(data));
                return true;
            },
        },
        resolveByDeletingRevision: async (_path, rev) => {
            try {
                await db.remove(path, rev);
                return AUTO_MERGED;
            } catch {
                return MISSING_OR_ERROR;
            }
        },
    } satisfies AutomaticRegionDependencies;
    return { db, chunks, backups, path, save, load, resolve: () => createAutomaticRegionResolver(dependencies)(path) };
}

async function sync(a: ReturnType<typeof peer>, b: ReturnType<typeof peer>) {
    for (const [key, text] of a.chunks) b.chunks.set(key, text);
    for (const [key, text] of b.chunks) a.chunks.set(key, text);
    await a.db.sync(b.db);
}

describe("automatic regions with real revision trees", () => {
    it("converges after concurrent offline edits and remains resolved after recreating the resolver", async () => {
        const desktop = peer();
        const phone = peer();
        try {
            const base = await desktop.save("Buy milk\nMeet Tuesday\nCall Alex\n", 1);
            await sync(desktop, phone);
            await desktop.save("Buy oat milk\nMeet Wednesday\nCall Alex\n", 100, base.rev);
            await phone.save("Buy milk\nMeet Thursday\nCall Alex tomorrow\n", 200, base.rev);
            await sync(desktop, phone);
            await Promise.all([desktop.resolve(), phone.resolve()]);
            await sync(desktop, phone);
            for (const p of [desktop, phone]) {
                const meta = await p.db.get(p.path, { conflicts: true });
                expect(meta._conflicts ?? []).toEqual([]);
                expect(meta.mtime).toBe(200);
                const loaded = await p.load(p.path);
                expect(loaded && loaded.data).toBe("Buy oat milk\nMeet Thursday\nCall Alex tomorrow\n");
                expect(p.backups.size).toBe(1);
            }
            // Reconstructing the resolver models loss of all its ephemeral state.
            await Promise.all([desktop.resolve(), phone.resolve()]);
            await sync(desktop, phone);
            expect((await desktop.db.get(desktop.path, { conflicts: true }))._conflicts ?? []).toEqual([]);
        } finally {
            await desktop.db.destroy();
            await phone.db.destroy();
        }
    });
});
