import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import MemoryAdapter from "pouchdb-adapter-memory";
import { PouchDB } from "../lib/pouchdb-node";
import { main, type CliCommandRunner } from "../main";
import { createDefaultCliSettings } from "../cliSettingsDefaults";
import { runCommand } from "./runCommand";
import { ReadOnlyRemoteService } from "../services/ReadOnlyRemoteService";
import { LiveSyncCouchDBReplicator } from "@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator";
import {
    MILESTONE_DOCID,
    type EntryDoc,
    type DocumentID,
    type CustomRegExpSourceList,
    type FilePathWithPrefix,
} from "@vrtmrz/livesync-commonlib/compat/common/types";

PouchDB.plugin(MemoryAdapter);

describe("CLI snapshot with real local databases and file decoding", () => {
    const originalArgv = process.argv.slice();
    const originalExitCode = process.exitCode;
    let directory: string;
    let source: PouchDB.Database<EntryDoc>;
    let signals: Map<"SIGINT" | "SIGTERM", Set<NodeJS.SignalsListener>>;
    const text = "Current note with Unicode: café 🌱\n";
    const standardIo = {
        readStdin: vi.fn(async () => text),
        prompt: vi.fn(async () => ""),
        writeStdout: vi.fn(),
        writeStderr: vi.fn(),
    };

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), "livesync-snapshot-"));
        source = new PouchDB<EntryDoc>(`snapshot-source-${crypto.randomUUID()}`, { adapter: "memory" });
        signals = new Map((["SIGINT", "SIGTERM"] as const).map((s) => [s, new Set(process.listeners(s))]));
        vi.spyOn(process, "exit").mockImplementation((code) => {
            throw new Error(`exit:${code ?? 0}`);
        });
        standardIo.writeStderr.mockClear();
    });

    afterEach(async () => {
        for (const [signal, previous] of signals) {
            for (const handler of process.listeners(signal))
                if (!previous.has(handler)) process.removeListener(signal, handler);
        }
        process.argv = originalArgv;
        process.exitCode = originalExitCode;
        vi.restoreAllMocks();
        await source.destroy();
        await rm(directory, { recursive: true, force: true });
    });

    async function start(name: string, command: string, runner: CliCommandRunner = runCommand, code = 0) {
        const database = join(directory, name, "db");
        const vault = join(directory, name, "export");
        await mkdir(database, { recursive: true });
        await mkdir(vault, { recursive: true });
        const settings = join(database, "settings.json");
        await writeFile(
            settings,
            JSON.stringify({
                ...createDefaultCliSettings(),
                isConfigured: true,
                encrypt: false,
                idDerivationVersion: 0,
                usePathObfuscation: false,
            })
        );
        process.argv = ["node", "livesync-cli", database, "--vault", vault, "--settings", settings, command];
        process.exitCode = undefined;
        await expect(main(standardIo, runner)).rejects.toThrow(`exit:${code}`);
        return vault;
    }

    async function seed() {
        await start("seed", "put", async (_options, context) => {
            const stored = await context.core.serviceModules.databaseFileAccess.storeContent(
                "notes/café.md" as FilePathWithPrefix,
                text
            );
            expect(stored).toBe(true);
            const image = join(directory, "image.bin");
            await writeFile(image, new Uint8Array([0, 255, 127, 128]));
            const binary = await runCommand({ command: "push", commandArgs: [image, "image.bin"] }, context);
            expect(binary).toBe(true);
            await PouchDB.replicate(context.core.services.database.localDatabase.localDatabase, source, {
                checkpoint: false,
            });
            return true;
        });
        await source.put({
            _id: MILESTONE_DOCID,
            type: "milestoneinfo",
            locked: true,
            accepted_nodes: ["desktop", "phone"],
            created: Date.now(),
            node_info: {},
            node_chunk_info: {},
            tweak_values: {},
        });
    }

    function connect() {
        const close = vi.fn(async () => undefined);
        const opening = vi
            .spyOn(LiveSyncCouchDBReplicator.prototype, "connectRemoteCouchDBWithSetting")
            .mockImplementation(async () => ({ db: source, info: await source.info(), close }));
        return { opening, close };
    }

    it("exports text and binary twice without registering devices or changing the source", async () => {
        await seed();
        const before = await source.info();
        const milestone = await source.get("_local/obsydian_livesync_milestone");
        const { opening, close } = connect();
        for (const name of ["first", "second"]) {
            const vault = await start(name, "snapshot", async (options, context) => {
                expect(context.core.services.remote).toBeInstanceOf(ReadOnlyRemoteService);
                return await runCommand(options, context);
            });
            expect(await readFile(join(vault, "notes/café.md"), "utf8")).toBe(text);
            expect([...(await readFile(join(vault, "image.bin")))]).toEqual([0, 255, 127, 128]);
        }
        expect((await source.info()).update_seq).toEqual(before.update_seq);
        expect(await source.get("_local/obsydian_livesync_milestone")).toEqual(milestone);
        expect(opening).toHaveBeenCalledTimes(2);
        expect(opening.mock.calls.every((call) => call[2] === false)).toBe(true);
        expect(close).toHaveBeenCalledTimes(2);
    });

    it("does not leave progress information requests pending when closing the connection", async () => {
        await seed();
        const info = await source.info();
        let infoReads = 0;
        let pendingReads = 0;
        const releases: Array<() => void> = [];
        vi.spyOn(source, "info").mockImplementation(async () => {
            infoReads++;
            if (infoReads > 2) {
                pendingReads++;
                await new Promise<void>((resolve) => releases.push(resolve));
                pendingReads--;
            }
            return info;
        });
        const { close } = connect();
        close.mockImplementation(async () => {
            if (pendingReads) throw new Error("Connection closed with pending progress requests");
        });
        try {
            const vault = await start("slow-progress", "snapshot");
            expect(await readFile(join(vault, "notes/café.md"), "utf8")).toBe(text);
            expect(infoReads).toBe(1);
            expect(close).toHaveBeenCalledOnce();
        } finally {
            for (const release of releases) release();
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    });

    it("refuses to reuse old local state", async () => {
        await seed();
        const { opening } = connect();
        await start("seed", "snapshot", runCommand, 1);
        expect(opening).not.toHaveBeenCalled();
    });

    it("rejects conflicted notes instead of exporting a selected winner", async () => {
        await seed();
        const doc = (await source.allDocs({ include_docs: true })).rows.find(
            (row) => (row.doc as { path?: string })?.path === "notes/café.md"
        )!.doc!;
        await source.bulkDocs(
            [
                { ...doc, _rev: "2-aaaa", _revisions: { start: 2, ids: ["aaaa", doc._rev!.split("-")[1]] } },
                { ...doc, _rev: "2-bbbb", _revisions: { start: 2, ids: ["bbbb", doc._rev!.split("-")[1]] } },
            ],
            { new_edits: false }
        );
        connect();
        await start("conflict", "snapshot", runCommand, 1);
        expect(standardIo.writeStderr.mock.calls.flat().map(String).join(" ")).toContain("unresolved note conflicts");
    });

    it("rejects a logical-deletion winner with a live conflict branch", async () => {
        await seed();
        const doc = (await source.allDocs({ include_docs: true })).rows.find(
            (row) => (row.doc as { path?: string })?.path === "notes/café.md"
        )!.doc!;
        const parent = doc._rev!.split("-")[1];
        await source.bulkDocs(
            [
                { ...doc, deleted: false, _rev: "2-aaaa", _revisions: { start: 2, ids: ["aaaa", parent] } },
                { ...doc, deleted: true, _rev: "2-ffff", _revisions: { start: 2, ids: ["ffff", parent] } },
            ],
            { new_edits: false }
        );
        expect(await source.get(doc._id, { conflicts: true })).toMatchObject({ deleted: true, _conflicts: ["2-aaaa"] });
        const before = await source.info();
        connect();
        await start("deleted-conflict", "snapshot", runCommand, 1);
        expect(standardIo.writeStderr.mock.calls.flat().map(String).join(" ")).toContain("unresolved note conflicts");
        expect((await source.info()).update_seq).toBe(before.update_seq);
        expect(await source.get(doc._id, { rev: "2-aaaa" })).toMatchObject({ deleted: false });
    });

    it("exports normal Metadata entries independently of filesystem target filters", async () => {
        await seed();
        const doc = (await source.allDocs({ include_docs: true })).rows.find(
            (row) => (row.doc as { path?: string })?.path === "notes/café.md"
        )!.doc!;
        if (doc.type !== "plain") throw new Error("The fixture must be a normal text entry.");
        const { _rev: _originalRevision, ...normal } = doc;
        await source.put({
            ...normal,
            _id: ".hidden-note.md" as DocumentID,
            path: ".hidden-note.md" as FilePathWithPrefix,
        });
        connect();
        const policy = {
            syncInternalFiles: false,
            syncOnlyRegEx: "^elsewhere/" as CustomRegExpSourceList<"|[]|">,
            syncIgnoreRegEx: "notes" as CustomRegExpSourceList<"|[]|">,
        };
        const vault = await start("hidden-normal", "snapshot", async (options, context) => {
            await context.core.services.setting.applyPartial(policy, true);
            const result = await runCommand(options, context);
            expect(context.core.services.setting.currentSettings()).toMatchObject(policy);
            return result;
        });
        expect(await readFile(join(vault, ".hidden-note.md"), "utf8")).toBe(text);
    });

    it("rejects a local database containing only tombstoned note history", async () => {
        await seed();
        const doc = (await source.allDocs({ include_docs: true })).rows.find(
            (row) => (row.doc as { path?: string })?.path === "notes/café.md"
        )!.doc!;
        const { opening } = connect();
        await start(
            "tombstoned-state",
            "snapshot",
            async (options, context) => {
                const local = context.core.services.database.localDatabase.localDatabase;
                await local.bulkDocs([doc], { new_edits: false });
                await local.remove(doc._id, doc._rev!);
                expect((await local.allDocs()).rows).toHaveLength(0);
                return await runCommand(options, context);
            },
            1
        );
        expect(opening).not.toHaveBeenCalled();
        expect(standardIo.writeStderr.mock.calls.flat().map(String).join(" ")).toContain("fresh local database");
    });

    it("fails on missing Chunks and leaves an existing Vault untouched", async () => {
        await seed();
        const chunk = (await source.allDocs()).rows.find((row) => row.id.startsWith("h:"))!;
        await source.remove(chunk.id, chunk.value.rev);
        connect();
        const policy = {
            syncInternalFiles: false,
            syncOnlyRegEx: "^notes/" as CustomRegExpSourceList<"|[]|">,
            syncIgnoreRegEx: "ignored" as CustomRegExpSourceList<"|[]|">,
        };
        await start(
            "missing",
            "snapshot",
            async (options, context) => {
                await context.core.services.setting.applyPartial(policy, true);
                try {
                    return await runCommand(options, context);
                } finally {
                    expect(context.core.services.setting.currentSettings()).toMatchObject(policy);
                }
            },
            1
        );
        expect(standardIo.writeStderr.mock.calls.flat().map(String).join(" ")).toContain(
            "Snapshot content is unavailable"
        );
        const vault = join(directory, "occupied", "export");
        await mkdir(vault, { recursive: true });
        await writeFile(join(vault, "private.md"), "unsynchronised edit");
        await start("occupied", "snapshot", runCommand, 1);
        expect(await readFile(join(vault, "private.md"), "utf8")).toBe("unsynchronised edit");
        expect(await readdir(vault)).toEqual(["private.md"]);
    });
});
