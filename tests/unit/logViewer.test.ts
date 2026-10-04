import { describe, test, assert } from "vitest";
import {
  POD_HUES,
  SourceColors,
  capRows,
  exportFileName,
  facetDisplayValue,
  formatLogTime,
  highlightSegments,
  logLevelOf,
  matchingRowIndexes,
  mergeByTimestamp,
  shortPodNames,
  stepMatch,
  type LogRow,
} from "../../src/lib/logViewer";
import { diffHunks, diffLines, diffSummary } from "../../src/lib/diff";

const row = (seq: number, timestamp: string, content = `line ${seq}`, pod?: string): LogRow => ({
  id: String(seq),
  seq,
  timestamp,
  content,
  data: null,
  pod,
});

describe("source colours", () => {
  test("first pods get distinct hues, stable per pod", () => {
    const colors = new SourceColors();
    const hues = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((p) => colors.hue(p));
    assert.equal(new Set(hues).size, POD_HUES.length);
    assert.equal(colors.hue("c"), hues[2]);
    // Hues repeat after the palette is used up.
    assert.equal(colors.hue("k"), hues[0]);
    colors.reset();
    assert.equal(colors.hue("z"), POD_HUES[0]);
  });

  test("short pod names drop the shared prefix", () => {
    const names = shortPodNames(["web-7d9f8b6c4-x2klq", "web-7d9f8b6c4-abcde", "web-55f-qq"]);
    assert.equal(names.get("web-7d9f8b6c4-x2klq"), "7d9f8b6c4-x2klq");
    assert.equal(names.get("web-55f-qq"), "55f-qq");
    const same = shortPodNames(["web-7d9f8b6c4-x2klq", "web-7d9f8b6c4-abcde"]);
    assert.equal(same.get("web-7d9f8b6c4-abcde"), "abcde");
    // A single pod and StatefulSet ordinals keep their full name.
    assert.equal(shortPodNames(["web-1"]).get("web-1"), "web-1");
    assert.equal(shortPodNames(["db-0", "db-1"]).get("db-1"), "db-1");
  });
});

describe("search", () => {
  test("highlight segments are case-insensitive", () => {
    assert.deepEqual(highlightSegments("Error: an error", "ERROR"), [
      { text: "Error", match: true },
      { text: ": an ", match: false },
      { text: "error", match: true },
    ]);
    assert.deepEqual(highlightSegments("abc", ""), [{ text: "abc", match: false }]);
    assert.deepEqual(highlightSegments("abc", "x"), [{ text: "abc", match: false }]);
  });

  test("matching rows and wrapping navigation", () => {
    const rows = [row(1, "t", "ok"), row(2, "t", "Timeout"), row(3, "t", "ok", "web-timeout-1")];
    assert.deepEqual(matchingRowIndexes(rows, "timeout"), [1, 2]);
    assert.deepEqual(matchingRowIndexes(rows, ""), []);
    assert.equal(stepMatch(2, -1, 1), 0);
    assert.equal(stepMatch(2, -1, -1), 1);
    assert.equal(stepMatch(2, 1, 1), 0);
    assert.equal(stepMatch(2, 0, -1), 1);
    assert.equal(stepMatch(0, 0, 1), -1);
  });
});

describe("ordering", () => {
  test("appends in order and merges out-of-order pod tails", () => {
    const a = [row(1, "2024-01-01T00:00:01.000000000Z"), row(2, "2024-01-01T00:00:03.000000000Z")];
    const appended = mergeByTimestamp(a, [row(3, "2024-01-01T00:00:04.000000000Z")]);
    assert.deepEqual(appended.map((r) => r.seq), [1, 2, 3]);

    const merged = mergeByTimestamp(a, [
      row(5, "2024-01-01T00:00:05.000000000Z"),
      row(4, "2024-01-01T00:00:02.000000000Z"),
    ]);
    assert.deepEqual(merged.map((r) => r.seq), [1, 4, 2, 5]);
    // Inputs are untouched.
    assert.equal(a.length, 2);
    // Equal timestamps keep arrival order.
    const tie = mergeByTimestamp([row(1, "t")], [row(2, "t")]);
    assert.deepEqual(tie.map((r) => r.seq), [1, 2]);
  });

  test("caps rows and drops evicted ones", () => {
    const rows = [1, 2, 3, 4, 5].map((s) => row(s, `t${s}`));
    assert.deepEqual(capRows(rows, 3, 0).map((r) => r.seq), [3, 4, 5]);
    assert.deepEqual(capRows(rows, 10, 4).map((r) => r.seq), [4, 5]);
    assert.strictEqual(capRows(rows, 10, 1), rows);
  });
});

describe("formatting", () => {
  test("log time, level, facet values, file names", () => {
    const local = new Date(2024, 0, 2, 3, 4, 5, 67);
    assert.equal(formatLogTime(local.toISOString()), "03:04:05.067");
    assert.equal(formatLogTime("garbage"), "garbage");
    assert.equal(logLevelOf({ severity: "WARN" }), "warn");
    assert.equal(logLevelOf(null), "");
    assert.equal(facetDisplayValue('"web-1"'), "web-1");
    assert.equal(facetDisplayValue("200"), "200");
    assert.equal(
      exportFileName("deployment/web", new Date(2024, 0, 2, 3, 4)),
      "deployment-web-20240102-0304.log"
    );
  });
});

describe("line diff", () => {
  test("adds, removes and context hunks", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "C", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n");
    const lines = diffLines(before, after);
    assert.deepEqual(diffSummary(lines), { added: 2, removed: 1 });
    const changed = lines.filter((l) => l.op !== "equal").map((l) => `${l.op}:${l.text}`);
    assert.deepEqual(changed, ["remove:c", "add:C", "add:k"]);

    const hunks = diffHunks(lines, 1);
    assert.equal(hunks.length, 2);
    assert.deepEqual(
      hunks[0].lines.map((l) => l.text),
      ["b", "c", "C", "d"]
    );
    assert.equal(hunks[0].oldStart, 2);
    assert.equal(hunks[1].newStart, 10);
  });

  test("identical and empty texts", () => {
    assert.deepEqual(diffHunks(diffLines("x\ny\n", "x\ny")), []);
    assert.deepEqual(diffSummary(diffLines("", "a\nb")), { added: 2, removed: 0 });
    assert.deepEqual(diffSummary(diffLines("a\nb", "")), { added: 0, removed: 2 });
  });

  test("interleaved changes keep line numbers consistent", () => {
    const a = "1\n2\n3\n4\n5\n6";
    const b = "0\n1\n3\n4\nx\n6\n7";
    const lines = diffLines(a, b);
    const rebuiltOld = lines.filter((l) => l.op !== "add").map((l) => l.text).join("\n");
    const rebuiltNew = lines.filter((l) => l.op !== "remove").map((l) => l.text).join("\n");
    assert.equal(rebuiltOld, a);
    assert.equal(rebuiltNew, b);
  });
});
