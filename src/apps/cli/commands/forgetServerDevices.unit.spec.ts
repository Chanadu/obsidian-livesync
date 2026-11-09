import { describe, expect, it, vi } from "vitest";
import {
    DEFAULT_SETTINGS,
    MILESTONE_DOCID,
    type EntryMilestoneInfo,
    type EntryDoc,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import {
    LiveSyncCouchDBReplicator,
    type LiveSyncCouchDBReplicatorEnv,
} from "@vrtmrz/livesync-commonlib/compat/replication/couchdb/LiveSyncReplicator";
import { forgetServerDevices } from "./forgetServerDevices";
import type { CLICommandContext } from "./types";

function fixture(serverCount = 3) {
    let milestone: EntryMilestoneInfo = {
        _id: MILESTONE_DOCID,
        _rev: "0-1",
        type: "milestoneinfo",
        created: 123,
        locked: true,
        accepted_nodes: [],
        node_info: {},
        node_chunk_info: {},
        tweak_values: {},
    };
    function add(id: string, platform?: string) {
        milestone.accepted_nodes.push(id);
        milestone.node_info[id] = {
            device_name: id,
            vault_name: "vault",
            app_version: "1",
            plugin_version: "1",
            progress: "",
            last_connected: 123,
            ...(platform ? { platform } : {}),
        };
        milestone.node_chunk_info[id] = { min: 1, max: 2, current: 2 };
        milestone.tweak_values[id] = { ...DEFAULT_SETTINGS };
    }
    add("desktop", "desktop");
    add("phone", "mobile");
    add("unknown");
    add("own", "server");
    for (let i = 0; i < serverCount; i++) add(`server-${i}`, "server");
    const db = {
        get: vi.fn(async (id: string) => {
            expect(id).toBe(MILESTONE_DOCID);
            return structuredClone(milestone);
        }),
        put: vi.fn(async (updated: EntryMilestoneInfo) => {
            expect(updated._id).toBe(MILESTONE_DOCID);
            expect(updated._rev).toBe(milestone._rev);
            milestone = { ...updated, _rev: `0-${Number(updated._rev!.split("-")[1]) + 1}` };
            return { ok: true, id: milestone._id, rev: milestone._rev };
        }),
    };
    const replicator = new LiveSyncCouchDBReplicator({
        services: {
            API: { isMobile: () => false },
            database: { localDatabase: { localDatabase: { get: async () => ({ nodeid: "own" }) } } },
        },
    } as unknown as LiveSyncCouchDBReplicatorEnv);
    vi.spyOn(replicator, "connectRemoteCouchDBWithSetting").mockImplementation(async () => ({
        db: db as unknown as PouchDB.Database<EntryDoc>,
        info: { db_name: "test", doc_count: 0, update_seq: 0 },
        close: async () => undefined,
    }));
    const snapshot = () => replicator.getJoinedDevices(DEFAULT_SETTINGS);
    const resource = {
        read: vi.fn(snapshot),
        forget: vi.fn((id: string) => replicator.forgetJoinedDevice(DEFAULT_SETTINGS, id)),
        dispose: vi.fn(async () => undefined),
    };
    const io = { writeStdout: vi.fn() };
    const context = {
        core: {
            services: {
                context: { standardIo: io },
                database: { localDatabase: { localDatabase: { get: vi.fn(async () => ({ nodeid: "own" })) } } },
                setting: { currentSettings: () => DEFAULT_SETTINGS },
                replicator: { createRemoteResource: vi.fn(async () => resource) },
            },
        },
    } as unknown as CLICommandContext;
    const apply = (force = true) => forgetServerDevices({ command: "forget-servers", commandArgs: [], force }, context);
    return { apply, context, resource, db, snapshot, add, io, current: () => milestone };
}

describe("bulk server-device cleanup", () => {
    it("previews by default without writing anything", async () => {
        const data = fixture();
        const before = structuredClone(data.current());
        expect(await data.apply(false)).toBe(true);
        expect(data.current()).toEqual(before);
        expect(data.resource.forget).not.toHaveBeenCalled();
        expect(data.resource.dispose).toHaveBeenCalledOnce();
    });

    it("removes hundreds of server records while preserving other devices and the remote lock", async () => {
        const data = fixture(200);
        const before = structuredClone(data.current());
        expect(await data.apply()).toBe(true);
        const remaining = data.current();
        expect(remaining.accepted_nodes).toEqual(["desktop", "phone", "unknown", "own"]);
        for (const id of remaining.accepted_nodes) {
            expect(remaining.node_info[id]).toEqual(before.node_info[id]);
            expect(remaining.node_chunk_info[id]).toEqual(before.node_chunk_info[id]);
            expect(remaining.tweak_values[id]).toEqual(before.tweak_values[id]);
        }
        expect(Object.keys(remaining.node_info)).toEqual(remaining.accepted_nodes);
        expect(Object.keys(remaining.node_chunk_info)).toEqual(remaining.accepted_nodes);
        expect(Object.keys(remaining.tweak_values)).toEqual(remaining.accepted_nodes);
        expect(remaining.locked).toBe(true);
        expect(remaining.created).toBe(before.created);
        expect(data.resource.forget).not.toHaveBeenCalledWith("own");
        expect(data.resource.dispose).toHaveBeenCalledOnce();
    });

    it("rechecks platform information before removal", async () => {
        const data = fixture(1);
        data.resource.read.mockImplementationOnce(async () => {
            const initial = await data.snapshot();
            data.current().node_info["server-0"].platform = "mobile";
            return initial;
        });
        expect(await data.apply()).toBe(true);
        expect(data.resource.forget).not.toHaveBeenCalled();
        expect(data.current().accepted_nodes).toContain("server-0");
    });

    it("stops on unsupported edits and releases the resource", async () => {
        const data = fixture();
        data.resource.forget.mockResolvedValueOnce("unsupported");
        await expect(data.apply()).rejects.toThrow("cleanup stopped");
        expect(data.resource.forget).toHaveBeenCalledTimes(1);
        expect(data.resource.dispose).toHaveBeenCalledOnce();
    });

    it("does not report success if a new server record appears during cleanup", async () => {
        const data = fixture(1);
        const original = data.resource.forget.getMockImplementation()!;
        data.resource.forget.mockImplementationOnce(async (id) => {
            const result = await original(id);
            data.add("returned-server", "server");
            return result;
        });
        await expect(data.apply()).rejects.toThrow("Server records remain or returned");
        expect(data.resource.dispose).toHaveBeenCalledOnce();
    });

    it("handles a concurrent removal", async () => {
        const data = fixture(1);
        const original = data.resource.forget.getMockImplementation()!;
        data.resource.forget.mockImplementationOnce(async (id) => {
            await original(id);
            return "not-found";
        });
        expect(await data.apply()).toBe(true);
        expect(data.current().accepted_nodes).not.toContain("server-0");
    });

    it("preserves a mobile device added during a revision conflict", async () => {
        const data = fixture(1);
        data.db.put.mockImplementationOnce(async () => {
            data.add("new-phone", "mobile");
            data.current()._rev = "0-2";
            throw Object.assign(new Error("conflict"), { status: 409 });
        });
        expect(await data.apply()).toBe(true);
        expect(data.current().accepted_nodes).toContain("new-phone");
        expect(data.current().accepted_nodes).not.toContain("server-0");
        expect(data.current().locked).toBe(true);
    });
});
