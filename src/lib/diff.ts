/*
 * Line diff (Myers' O(ND) algorithm) and unified-diff hunks, used to compare
 * rollout revisions and Helm values / manifests without pulling in an editor.
 */

export type DiffOp = "equal" | "add" | "remove";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /* 1-based line numbers in the old / new text (null when absent). */
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  /* "@@ -a,b +c,d @@" header values */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffSummary {
  added: number;
  removed: number;
}

/* Edit distances above this fall back to "replace everything". */
const MAX_EDIT_DISTANCE = 4000;

const splitLines = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Line by line diff of two texts. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  return diffArrays(splitLines(oldText), splitLines(newText));
}

export function diffArrays(a: string[], b: string[]): DiffLine[] {
  // Common prefix / suffix are cheap and shrink the search a lot.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const middle = myers(middleA, middleB);

  const ops: DiffOp[] = [
    ...Array<DiffOp>(prefix).fill("equal"),
    ...middle,
    ...Array<DiffOp>(suffix).fill("equal"),
  ];

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "equal") {
      result.push({ op, text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (op === "remove") {
      result.push({ op, text: a[i], oldLine: i + 1, newLine: null });
      i++;
    } else {
      result.push({ op, text: b[j], oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  return result;
}

/** Edit script turning `a` into `b` (removes before adds per change). */
function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array<DiffOp>(m).fill("add");
  if (m === 0) return Array<DiffOp>(n).fill("remove");

  const max = n + m;
  const offset = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  let found = false;
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) break;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    return [...Array<DiffOp>(n).fill("remove"), ...Array<DiffOp>(m).fill("add")];
  }

  // Backtrack through the saved V arrays.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    v = trace[d];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? k + 1
        : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("equal");
      x--;
      y--;
    }
    if (d > 0) {
      ops.push(x === prevX ? "add" : "remove");
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return normalizeOrder(ops);
}

/* Within each run of changes, show removals before additions. */
function normalizeOrder(ops: DiffOp[]): DiffOp[] {
  const result: DiffOp[] = [];
  let removes = 0;
  let adds = 0;
  const flush = () => {
    for (let i = 0; i < removes; i++) result.push("remove");
    for (let i = 0; i < adds; i++) result.push("add");
    removes = 0;
    adds = 0;
  };
  for (const op of ops) {
    if (op === "remove") removes++;
    else if (op === "add") adds++;
    else {
      flush();
      result.push(op);
    }
  }
  flush();
  return result;
}

export function diffSummary(lines: DiffLine[]): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === "add") added++;
    else if (line.op === "remove") removed++;
  }
  return { added, removed };
}

/** Groups a diff into hunks with `context` unchanged lines around changes. */
export function diffHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const changed = lines
    .map((line, index) => (line.op === "equal" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return hunks;

  let start = Math.max(0, changed[0] - context);
  let end = Math.min(lines.length - 1, changed[0] + context);
  const ranges: [number, number][] = [];
  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(lines.length - 1, index + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, index - context);
      end = Math.min(lines.length - 1, index + context);
    }
  }
  ranges.push([start, end]);

  for (const [from, to] of ranges) {
    const hunkLines = lines.slice(from, to + 1);
    const firstOld = hunkLines.find((l) => l.oldLine !== null)?.oldLine ?? 0;
    const firstNew = hunkLines.find((l) => l.newLine !== null)?.newLine ?? 0;
    hunks.push({
      oldStart: firstOld,
      oldLines: hunkLines.filter((l) => l.op !== "add").length,
      newStart: firstNew,
      newLines: hunkLines.filter((l) => l.op !== "remove").length,
      lines: hunkLines,
    });
  }
  return hunks;
}
