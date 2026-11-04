import { diff3Merge } from "node-diff3";

export interface MergeVersion {
    rev: string;
    mtime: number;
    data: string;
}

/** Compare original edit times, with a locale-independent tie-breaker. */
export function compareVersions(left: MergeVersion, right: MergeVersion): number {
    const time = (Number.isFinite(left.mtime) ? left.mtime : 0) - (Number.isFinite(right.mtime) ? right.mtime : 0);
    return time || (left.rev < right.rev ? -1 : left.rev > right.rev ? 1 : 0);
}

function lines(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// Keep whitespace and punctuation as tokens, rather than splitting and rejoining
// on spaces. Whole words prevent competing replacements becoming hybrid words.
function words(text: string): string[] {
    return text.match(/[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu) ?? [];
}

/** Preserve independent edits and choose the newer side only inside conflicts. */
export function mergeRegions(base: string, left: MergeVersion, right: MergeVersion): string {
    // Canonical input order makes the diff alignment independent of the device
    // that happened to receive these branches first.
    const [older, newer] = compareVersions(left, right) <= 0 ? [left, right] : [right, left];
    const result: string[] = [];
    for (const region of diff3Merge(lines(older.data), lines(base), lines(newer.data))) {
        if (region.ok) {
            result.push(...region.ok);
        } else if (region.conflict) {
            const conflict = region.conflict;
            for (const part of diff3Merge(
                words(conflict.a.join("")),
                words(conflict.o.join("")),
                words(conflict.b.join(""))
            )) {
                if (part.ok) result.push(...part.ok);
                else if (part.conflict) result.push(...part.conflict.b);
            }
        }
    }
    return result.join("");
}
