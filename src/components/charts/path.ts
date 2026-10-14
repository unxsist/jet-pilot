/*
 * SVG paths of the time-series chart: smooth monotone curves (they never
 * overshoot the data, so a flat line stays flat and a peak isn't invented),
 * split at gaps, an area under them, and stepped reference lines.
 */

export interface Point {
  x: number;
  y: number;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/* Fritsch–Carlson tangents, as d3's curveMonotoneX. */
function interiorSlope(p0: Point, p1: Point, p2: Point): number {
  const h0 = p1.x - p0.x;
  const h1 = p2.x - p1.x;
  const s0 = h0 ? (p1.y - p0.y) / h0 : 0;
  const s1 = h1 ? (p2.y - p1.y) / h1 : 0;
  const p = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
  return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
}

function endSlope(p0: Point, p1: Point, t: number): number {
  const h = p1.x - p0.x;
  return h ? (3 * (p1.y - p0.y)) / h / 2 - t / 2 : t;
}

/** A monotone cubic curve through the points (sorted by x). */
export function monotonePath(points: Point[]): string {
  const n = points.length;
  if (n === 0) return "";
  const first = points[0]!;
  if (n === 1) return `M${f(first.x)},${f(first.y)}Z`;
  if (n === 2) return `M${f(first.x)},${f(first.y)}L${f(points[1]!.x)},${f(points[1]!.y)}`;
  const t = new Array<number>(n);
  for (let i = 1; i < n - 1; i++) t[i] = interiorSlope(points[i - 1]!, points[i]!, points[i + 1]!);
  t[0] = endSlope(points[0]!, points[1]!, t[1]!);
  t[n - 1] = endSlope(points[n - 2]!, points[n - 1]!, t[n - 2]!);
  let d = `M${f(first.x)},${f(first.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = (b.x - a.x) / 3;
    d += `C${f(a.x + dx)},${f(a.y + dx * t[i]!)},${f(b.x - dx)},${f(b.y - dx * t[i + 1]!)},${f(b.x)},${f(b.y)}`;
  }
  return d;
}

/** Runs of consecutive non-null values, as points. */
export function segments(
  values: (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number
): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  values.forEach((value, index) => {
    if (value === null || value === undefined) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: x(index), y: y(value) });
  });
  if (run.length) runs.push(run);
  return runs;
}

/** The line: one curve per run (gaps stay gaps). */
export function linePath(runs: Point[][]): string {
  return runs.map(monotonePath).join("");
}

/** The area between each run's curve and the baseline. */
export function areaPath(runs: Point[][], baseline: number): string {
  return runs
    .filter((run) => run.length > 1)
    .map((run) => {
      const last = run[run.length - 1]!;
      return `${monotonePath(run)}L${f(last.x)},${f(baseline)}L${f(run[0]!.x)},${f(baseline)}Z`;
    })
    .join("");
}

/** A stepped line (requests and limits change at a point in time, not gradually). */
export function stepPath(runs: Point[][]): string {
  return runs
    .map((run) =>
      run
        .map((p, i) => (i === 0 ? `M${f(p.x)},${f(p.y)}` : `H${f(p.x)}V${f(p.y)}`))
        .join("")
    )
    .join("");
}
