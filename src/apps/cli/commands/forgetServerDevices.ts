import { NODEINFO_DOCID, type EntryNodeInfo } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { REMOTE_RESOURCE_KINDS } from "@vrtmrz/livesync-commonlib/replication";
import { withOwnedRemoteResource } from "@/common/ownedRemoteResource";
import type { CLICommandContext, CLIOptions } from "./types";

/** Remove only positively identified headless registrations using the provider's conflict-safe editor. */
export async function forgetServerDevices(options: CLIOptions, context: CLICommandContext): Promise<boolean> {
    if (options.commandArgs.length) throw new Error("forget-servers does not accept positional arguments.");
    const { core } = context;
    const { standardIo } = core.services.context;
    const ownInfo = await core.services.database.localDatabase.localDatabase.get<EntryNodeInfo>(NODEINFO_DOCID);
    if (typeof ownInfo.nodeid !== "string" || !ownInfo.nodeid)
        throw new Error("The local device identity is unavailable.");
    const resource = await core.services.replicator.createRemoteResource(REMOTE_RESOURCE_KINDS.JOINED_DEVICES, {
        ...core.services.setting.currentSettings(),
    });
    if (!resource) throw new Error("Joined-device management is unavailable.");
    return await withOwnedRemoteResource(resource, async (owned) => {
        const initial = await owned.read();
        const targets = initial.devices.filter(
            (device) => device.platform === "server" && device.id !== ownInfo.nodeid
        );
        standardIo.writeStdout(`[Devices] Found ${targets.length} server records eligible for removal.\n`);
        if (!options.force) {
            for (const device of targets) standardIo.writeStdout(`[Devices] ${device.id}\n`);
            standardIo.writeStdout("[Devices] Preview only. Add --force to remove these server records.\n");
            return true;
        }
        let removed = 0;
        for (const target of targets) {
            // Recheck classification rather than trusting a stale preview.
            const current = await owned.read();
            if (!current.devices.some((device) => device.id === target.id && device.platform === "server")) continue;
            const result = await owned.forget(target.id);
            if (result === "forgotten") {
                removed++;
                standardIo.writeStdout(`[Devices] Removed ${removed}/${targets.length} server records.\n`);
            } else if (result !== "not-found") {
                throw new Error(
                    `Server-device cleanup stopped after ${removed} removals (${result}). Retry after reviewing the list.`
                );
            }
        }
        const final = await owned.read();
        if (final.devices.some((device) => device.platform === "server" && device.id !== ownInfo.nodeid)) {
            throw new Error(
                "Server records remain or returned during cleanup. Keep the old backup job stopped and retry."
            );
        }
        standardIo.writeStdout(
            `[Devices] Removed ${removed} server records. Desktop, mobile, and unknown-platform records were not selected.\n`
        );
        return true;
    });
}
