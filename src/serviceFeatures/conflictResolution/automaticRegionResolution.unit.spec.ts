import { describe, expect, it, vi } from "vitest";
import {
    AUTO_MERGED,
    MISSING_OR_ERROR,
    NOT_CONFLICTED,
    type FilePathWithPrefix,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import {
    createAutomaticRegionResolver,
    type AutomaticRegionDependencies,
    type RevisionMetadata,
} from "./automaticRegionResolution";

function harness() {
    const path = "note.md" as FilePathWithPrefix;
    const entries = new Map<string, RevisionMetadata>();
    const entry = (rev: string, data: string, mtime: number) =>
        ({
            _id: "note.md",
            _rev: rev,
            path,
            data,
            mtime,
            ctime: 1,
            datatype: "plain",
            type: "plain",
            _revs_info: [
                { rev, status: "available" },
                { rev: "1-base", status: "available" },
            ],
        }) as unknown as RevisionMetadata;
    entries.set("1-base", entry("1-base", "Buy milk\nMeet Tuesday\nCall Alex\n", 1));
    entries.set("2-a", entry("2-a", "Buy oat milk\nMeet Wednesday\nCall Alex\n", 100));
    entries.set("2-b", entry("2-b", "Buy milk\nMeet Thursday\nCall Alex tomorrow\n", 200));
    let current = { ...entries.get("2-b")!, _conflicts: ["2-a"] };
    const getDBEntryMeta = vi.fn(async (_path: unknown, options?: { rev?: string }) =>
        options?.rev ? (entries.get(options.rev) ?? false) : current
    );
    const getDBEntry = vi.fn(
        async (_path: unknown, options?: { rev?: string }) => entries.get(options?.rev ?? "") ?? false
    );
    const store = vi.fn(async () => "3-merged" as string | false);
    const backup = vi.fn(async () => true);
    const remove = vi.fn(async () => AUTO_MERGED);
    const dependencies = {
        localDatabase: () => ({ getDBEntryMeta, getDBEntry }),
        databaseFileAccess: { storeWithLiveBaseRevision: store },
        storageAccess: { writeHiddenFileAuto: backup, ensureDir: vi.fn(async () => true) },
        resolveByDeletingRevision: remove,
    } as AutomaticRegionDependencies;
    return {
        path,
        entries,
        store,
        backup,
        remove,
        getDBEntryMeta,
        setCurrent: (value: typeof current) => {
            current = value;
        },
        resolve: createAutomaticRegionResolver(dependencies),
    };
}

describe("automatic region resolution persistence", () => {
    it("backs up inputs, preserves independent text, and stores using original edit time and exact parent", async () => {
        const h = harness();
        expect(await h.resolve(h.path)).toBe(AUTO_MERGED);
        const [file, parent] = h.store.mock.calls[0] as unknown as [{ body: Blob; stat: { mtime: number } }, string];
        expect(await file.body.text()).toBe("Buy oat milk\nMeet Thursday\nCall Alex tomorrow\n");
        expect(file.stat.mtime).toBe(200);
        expect(parent).toBe("2-b");
        expect(h.backup.mock.invocationCallOrder[0]).toBeLessThan(h.store.mock.invocationCallOrder[0]);
        expect(h.store.mock.invocationCallOrder[0]).toBeLessThan(h.remove.mock.invocationCallOrder[0]);
        expect(h.remove).toHaveBeenCalledWith(h.path, "2-a", "Automatic region merge");
    });

    it("keeps the newer file automatically when no shared ancestor exists", async () => {
        const h = harness();
        h.entries.get("2-a")!._revs_info = [];
        expect(await h.resolve(h.path)).toBe(AUTO_MERGED);
        expect(h.store).not.toHaveBeenCalled();
        expect(h.remove).toHaveBeenCalledWith(h.path, "2-a", "Automatic region merge");
        expect(JSON.parse((h.backup.mock.calls[0] as unknown as [string, string])[1]).hasBase).toBe(false);
    });

    it("never discards a branch when recovery storage fails", async () => {
        const h = harness();
        h.backup.mockResolvedValue(false);
        expect(await h.resolve(h.path)).toBe(MISSING_OR_ERROR);
        expect(h.store).not.toHaveBeenCalled();
        expect(h.remove).not.toHaveBeenCalled();
    });

    it("never discards a branch when the merged write fails", async () => {
        const h = harness();
        h.store.mockResolvedValue(false);
        expect(await h.resolve(h.path)).toBe(MISSING_OR_ERROR);
        expect(h.remove).not.toHaveBeenCalled();
    });

    it("leaves unreadable revisions intact", async () => {
        const h = harness();
        h.entries.delete("2-a");
        expect(await h.resolve(h.path)).toBe(MISSING_OR_ERROR);
        expect(h.remove).not.toHaveBeenCalled();
    });

    it("rechecks leaves after writing the recovery copy", async () => {
        const h = harness();
        h.backup.mockImplementation(async () => {
            h.setCurrent({ ...h.entries.get("2-b")!, _rev: "3-changed", _conflicts: ["2-a"] });
            return true;
        });
        expect(await h.resolve(h.path)).toBe(MISSING_OR_ERROR);
        expect(h.store).not.toHaveBeenCalled();
        expect(h.remove).not.toHaveBeenCalled();
    });

    it("treats absence of conflicts as completed work", async () => {
        const h = harness();
        h.setCurrent({ ...h.entries.get("2-b")!, _conflicts: [] });
        expect(await h.resolve(h.path)).toBe(NOT_CONFLICTED);
        expect(h.remove).not.toHaveBeenCalled();
    });
});
