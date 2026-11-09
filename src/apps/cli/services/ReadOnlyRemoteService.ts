import { InjectableRemoteService } from "@vrtmrz/livesync-commonlib/compat/services/implements/injectable/InjectableRemoteService";
import type { NodeServiceContext } from "./NodeServiceContext";

/** Permit CouchDB reads, including its two read-only document batch endpoints. */
export function assertReadOnlyRequest(request: string | Request, options?: RequestInit): void {
    const method = (options?.method ?? (typeof request === "string" ? "GET" : request.method)).toUpperCase();
    const url = new URL(typeof request === "string" ? request : request.url);
    const endpoint = url.pathname.split("/").pop();
    if (method === "GET" || method === "HEAD") return;
    if (method === "POST" && (endpoint === "_all_docs" || endpoint === "_bulk_get")) return;
    throw new Error(`Snapshot refused a remote ${method} request.`);
}

/** Enforce the snapshot's no-write contract before either HTTP adapter runs. */
export class ReadOnlyRemoteService<T extends NodeServiceContext> extends InjectableRemoteService<T> {
    override async performFetch(...args: Parameters<InjectableRemoteService<T>["performFetch"]>): Promise<Response> {
        assertReadOnlyRequest(args[0], args[1]);
        return await super.performFetch(...args);
    }
}
