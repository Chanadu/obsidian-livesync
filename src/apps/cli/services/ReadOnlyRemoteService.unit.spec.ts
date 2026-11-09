import { describe, expect, it, vi } from "vitest";
import { InjectableRemoteService } from "@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableRemoteService";
import { assertReadOnlyRequest, ReadOnlyRemoteService } from "./ReadOnlyRemoteService";

describe("snapshot remote request boundary", () => {
    it.each([
        ["GET", "_changes"],
        ["HEAD", "note"],
        ["POST", "_all_docs"],
        ["POST", "_bulk_get"],
    ])("permits %s %s", (method, endpoint) => {
        expect(() => assertReadOnlyRequest(`https://example.invalid/vault/${endpoint}`, { method })).not.toThrow();
    });

    it.each([
        ["PUT", "_local/obsydian_livesync_milestone"],
        ["PUT", "_local/checkpoint"],
        ["POST", "_bulk_docs"],
        ["DELETE", "note"],
        ["POST", "_compact"],
        ["PUT", "_all_docs"],
        ["PATCH", "note"],
    ])("rejects %s %s", (method, endpoint) => {
        expect(() => assertReadOnlyRequest(`https://example.invalid/vault/${endpoint}`, { method })).toThrow(
            "Snapshot refused"
        );
    });

    it("checks Request methods and init overrides", () => {
        const request = new Request("https://example.invalid/vault/note", { method: "PUT" });
        expect(() => assertReadOnlyRequest(request)).toThrow("Snapshot refused");
        expect(() => assertReadOnlyRequest(request, { method: "GET" })).not.toThrow();
    });

    it("blocks writes before delegating to either transport adapter", async () => {
        const transport = vi.spyOn(InjectableRemoteService.prototype, "performFetch");
        try {
            // The boundary uses no instance state before deciding whether to delegate.
            await expect(
                ReadOnlyRemoteService.prototype.performFetch.call(
                    Object.create(ReadOnlyRemoteService.prototype),
                    "https://example.invalid/vault/_bulk_docs",
                    { method: "POST" },
                    1
                )
            ).rejects.toThrow("Snapshot refused");
            expect(transport).not.toHaveBeenCalled();
        } finally {
            transport.mockRestore();
        }
    });
});
