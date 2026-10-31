import { describe, test, assert } from "vitest";
import {
  LogTimeline,
  bucketStep,
  formatBucketTime,
  formatTimeRange,
  snapRange,
} from "../../src/lib/logTimeline";
import { capRows, mergeByTimestamp, type LogRow } from "../../src/lib/logViewer";

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");

let seq = 0;
const row = (ms: number, level?: string): LogRow => {
  seq++;
  return {
    id: String(seq),
    seq,
    timestamp: iso(ms),
    content: `line ${seq}`,
    data: level ? { level } : { message: "plain" },
  };
};

/* Counts of every bucket, recomputed from scratch (the reference). */
const naive = (rows: LogRow[], start: number, end: number) => {
  const inRange = rows.filter((r) => {
    const t = Date.parse(r.timestamp);
    return t >= start && t < end;
  });
  const level = (r: LogRow) => (r.data as { level?: string }).level;
  return {
    total: inRange.length,
    error: inRange.filter((r) => level(r) === "error").length,
    warn: inRange.filter((r) => level(r) === "warn").length,
  };
};

const assertMatchesNaive = (timeline: LogTimeline, rows: LogRow[]) => {
  const result = timeline.buckets(40, 0);
  assert.ok(result);
  for (const bucket of result!.buckets) {
    const expected = naive(rows, bucket.start, bucket.end);
    assert.deepEqual(
      { total: bucket.total, error: bucket.error, warn: bucket.warn },
      expected,
      `bucket ${bucket.start}`
    );
  }
  assert.equal(
    result!.buckets.reduce((sum, b) => sum + b.total, 0),
    rows.length
  );
};

describe("log timeline", () => {
  test("bucket steps are round and adapt to the span", () => {
    assert.equal(bucketStep(60_000, 60), 1000);
    assert.equal(bucketStep(61_000, 60), 2000);
    assert.equal(bucketStep(3_600_000, 60), 60_000);
    assert.equal(bucketStep(300, 60), 5);
    assert.equal(bucketStep(7 * 86_400_000, 60), 3 * 3_600_000);
  });

  test("counts lines and levels per bucket", () => {
    const rows = [
      row(T0, "info"),
      row(T0 + 400, "error"),
      row(T0 + 1_500, "warn"),
      row(T0 + 1_600, "warn"),
      row(T0 + 9_999, "error"),
    ];
    const timeline = new LogTimeline();
    timeline.update(rows);
    assert.isTrue(timeline.hasLevels);
    const result = timeline.buckets(10, 0)!;
    assert.equal(result.step, 1000);
    assert.equal(result.buckets.length, 10);
    assert.deepEqual(
      result.buckets.map((b) => [b.total, b.error, b.warn]),
      [[2, 1, 0], [2, 0, 2], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [1, 1, 0]]
    );
    assert.equal(result.max, 2);
  });

  test("never exceeds the bucket budget after aligning the first edge", () => {
    const rows = [row(T0 + 999), row(T0 + 10_500)];
    const timeline = new LogTimeline();
    timeline.update(rows);
    const result = timeline.buckets(10, 0)!;
    assert.isAtMost(result.buckets.length, 10);
    assert.equal(result.buckets[0].start % result.step, 0);
  });

  test("lines without a parsed level leave the bars untinted", () => {
    const timeline = new LogTimeline();
    timeline.update([row(T0), row(T0 + 1000)]);
    assert.isFalse(timeline.hasLevels);
  });

  test("no span to draw for a single line or one instant", () => {
    const timeline = new LogTimeline();
    timeline.update([row(T0)]);
    assert.isNull(timeline.buckets(10));
    timeline.update([row(T0), row(T0)]);
    assert.isNull(timeline.buckets(10));
  });

  test("appends, the cap and late lines update incrementally and stay exact", () => {
    const timeline = new LogTimeline();
    let rows: LogRow[] = [];
    const levels = ["info", "warn", "error", "debug", undefined];
    for (let batch = 0; batch < 30; batch++) {
      const incoming = Array.from({ length: 25 }, (_, i) =>
        // Every third batch has lines from another pod that arrive late.
        row(T0 + batch * 2_000 + i * 70 - (batch % 3 === 0 ? 3_000 : 0), levels[(batch + i) % 5])
      );
      rows = capRows(mergeByTimestamp(rows, incoming), 300, 0);
      timeline.update(rows);
      assert.equal(timeline.length, rows.length);
      assertMatchesNaive(timeline, rows);
    }
  });

  test("a full refetch (new array of other rows) rebuilds", () => {
    const timeline = new LogTimeline();
    timeline.update([row(T0, "error"), row(T0 + 1000, "error")]);
    const rows = [row(T0 + 5000, "warn"), row(T0 + 6000), row(T0 + 7000)];
    timeline.update(rows);
    assert.equal(timeline.length, 3);
    assertMatchesNaive(timeline, rows);
    timeline.update([]);
    assert.equal(timeline.length, 0);
    assert.isNull(timeline.span());
  });

  test("index ranges select the rows of a time range", () => {
    const rows = [row(T0), row(T0 + 1000), row(T0 + 1000), row(T0 + 2500), row(T0 + 4000)];
    const timeline = new LogTimeline();
    timeline.update(rows);
    assert.deepEqual(timeline.indexRange(T0 + 1000, T0 + 3000), [1, 4]);
    assert.deepEqual(timeline.indexRange(T0 - 10, T0 + 10_000), [0, 5]);
    assert.deepEqual(timeline.indexRange(T0 + 5000, T0 + 6000), [5, 5]);
  });

  test("unparseable timestamps keep the order (their neighbour's time)", () => {
    const rows = [row(T0), { ...row(T0 + 500), timestamp: "garbage" }, row(T0 + 2000)];
    const timeline = new LogTimeline();
    timeline.update(rows);
    assert.deepEqual(timeline.indexRange(T0, T0 + 1), [0, 2]);
    assert.deepEqual(timeline.span(), { start: T0, end: T0 + 2000 });
  });

  test("brushing snaps to whole buckets", () => {
    const timeline = new LogTimeline();
    timeline.update([row(T0), row(T0 + 9_500)]);
    const { buckets } = timeline.buckets(10, 0)!;
    // 10 buckets over 200 px: 20 px each.
    assert.deepEqual(snapRange(buckets, 200, 25, 65), [T0 + 1000, T0 + 4000]);
    assert.deepEqual(snapRange(buckets, 200, 65, 25), [T0 + 1000, T0 + 4000]);
    assert.deepEqual(snapRange(buckets, 200, -40, 5), [T0, T0 + 1000]);
    assert.deepEqual(snapRange(buckets, 200, 190, 999), [T0 + 9000, T0 + 10_000]);
    assert.isNull(snapRange([], 200, 0, 10));
  });

  test("labels are as precise as the buckets", () => {
    const local = new Date(2026, 9, 31, 14, 3, 7, 250).getTime();
    assert.equal(formatBucketTime(local, 60_000), "14:03");
    assert.equal(formatBucketTime(local, 5_000), "14:03:07");
    assert.equal(formatBucketTime(local, 100), "14:03:07.250");
    assert.equal(formatTimeRange(local, local + 5_000, 5_000), "14:03:07–14:03:12");
    const nextDay = new Date(2026, 10, 1, 1, 0).getTime();
    assert.match(formatTimeRange(local, nextDay, 3_600_000), /^\S+ \d+ 14:03–\S+ \d+ 01:00$/);
  });
});
