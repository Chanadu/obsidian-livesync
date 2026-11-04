import { describe, expect, it } from "vitest";
import { compareVersions, mergeRegions, type MergeVersion } from "./regionMerge";

function version(data: string, mtime: number, rev = `${mtime}-revision`): MergeVersion {
    return { data, mtime, rev };
}

describe("automatic region merge", () => {
    it.each([
        {
            name: "keeps independent paragraphs and picks the newer overlapping word",
            base: "Buy milk\n\nMeet Tuesday\n\nCall Alex\n",
            left: "Buy oat milk\n\nMeet Wednesday\n\nCall Alex\n",
            right: "Buy milk\n\nMeet Thursday\n\nCall Alex tomorrow\n",
            expected: "Buy oat milk\n\nMeet Thursday\n\nCall Alex tomorrow\n",
        },
        {
            name: "preserves independent words on the same line",
            base: "Buy milk and call Alex\n",
            left: "Buy oat milk and call Alex\n",
            right: "Buy milk and call Alex tomorrow\n",
            expected: "Buy oat milk and call Alex tomorrow\n",
        },
        {
            name: "never combines competing words into a hybrid",
            base: "The colour is red.\n",
            left: "The colour is purple.\n",
            right: "The colour is green.\n",
            expected: "The colour is green.\n",
        },
        {
            name: "newer deletion wins over a replacement",
            base: "Keep this\nRemove this\n",
            left: "Keep this\nChanged this\n",
            right: "Keep this\n",
            expected: "Keep this\n",
        },
        {
            name: "newer replacement wins over a deletion",
            base: "Keep this\nRemove this\n",
            left: "Keep this\n",
            right: "Keep this\nChanged this\n",
            expected: "Keep this\nChanged this\n",
        },
        {
            name: "retains CRLF and an absent final newline",
            base: "one\r\ntwo\r\nthree",
            left: "ONE\r\ntwo\r\nthree",
            right: "one\r\nTWO\r\nthree",
            expected: "ONE\r\nTWO\r\nthree",
        },
        {
            name: "preserves Unicode words and emoji",
            base: "Café red 🐈\n",
            left: "Café blue 🐈\n",
            right: "Café green 🐕\n",
            expected: "Café green 🐕\n",
        },
        {
            name: "competing insertions at the same point choose the newer text",
            base: "",
            left: "old insert",
            right: "new insert",
            expected: "new insert",
        },
        {
            name: "identical changes occur once",
            base: "before\n",
            left: "after\n",
            right: "after\n",
            expected: "after\n",
        },
        {
            name: "literal conflict markers remain ordinary note content",
            base: "<<<<<<< example\nbase\n",
            left: "<<<<<<< example\nolder\n",
            right: "<<<<<<< example\nnewer\n",
            expected: "<<<<<<< example\nnewer\n",
        },
    ])("$name", ({ base, left, right, expected }) => {
        const a = version(left, 100);
        const b = version(right, 200);
        expect(mergeRegions(base, a, b)).toBe(expected);
        expect(mergeRegions(base, b, a)).toBe(expected);
    });

    it("uses revision identity to break equal timestamps on every device", () => {
        const a = version("older", 100, "2-a");
        const b = version("newer", 100, "2-b");
        expect(compareVersions(a, b)).toBeLessThan(0);
        expect(mergeRegions("base", a, b)).toBe("newer");
        expect(mergeRegions("base", b, a)).toBe("newer");
    });
});
