/*
 * Resource table pipeline: correctness against the TanStack baseline, and
 * micro-benchmarks with 5k / 20k synthetic pods:
 *
 *   BENCH=1 npx vitest run tests/unit/tablePerf.test.ts
 *
 * - keystroke: type-to-filter one more character, render the visible window
 * - keystroke after refresh: same, right after new data arrived (cold caches)
 * - refresh: the data layer delivers a new list (every row a new object, 1%
 *   with a new resourceVersion), unsorted and sorted by name, then the
 *   visible window renders
 *
 * "baseline" is the origin/main pipeline (tests/bench/baselinePipeline.ts),
 * "table" the current VirtualDataTable pipeline (useTableModel).
 */
import { describe, expect, test } from "vitest";
import { ref, shallowRef } from "vue";
import type { ColumnDef, Row } from "@tanstack/vue-table";
import { columns as podColumns } from "@/components/tables/pods";
import { multiContextColumns } from "@/components/tables/multicontext";
import { useTableModel } from "@/components/tables/useTableModel";
import { getPodRestarts } from "@/components/tables/status";
import { createBaselinePipeline } from "../bench/baselinePipeline";
import {
  refreshedPods,
  syntheticPods,
  type SyntheticPod,
} from "../bench/syntheticPods";

const columns = [...multiContextColumns, ...podColumns] as ColumnDef<
  SyntheticPod,
  any
>[];

const VISIBLE = 40;
const QUERY = "payments-api-3";
const keystrokes = Array.from({ length: QUERY.length }, (_, i) =>
  QUERY.slice(0, i + 1)
);

/*
 * What a render of the visible window costs: classes, values, cell vnodes.
 * With `memo`, rows whose object did not change since the last render are
 * skipped, like the table's v-memo does.
 */
function renderWindow(
  rows: Row<SyntheticPod>[],
  memo?: Map<string, SyntheticPod>
) {
  let n = 0;
  for (const row of rows.slice(0, VISIBLE)) {
    if (memo) {
      if (memo.get(row.id) === row.original) continue;
      memo.set(row.id, row.original);
    }
    for (const cell of row.getVisibleCells()) {
      const def = cell.column.columnDef;
      def.meta?.class?.(row.original);
      cell.getValue();
      if (typeof def.cell === "function") {
        def.cell(cell.getContext());
      }
      n++;
    }
  }
  return n;
}

/* Median / p90 of up to `iterations` runs within a ~8s budget. */
function measure(
  fn: () => void,
  iterations: number,
  setup?: () => void,
  budgetMs = 8000
) {
  setup?.();
  fn();
  const samples: number[] = [];
  const deadline = performance.now() + budgetMs;
  for (let i = 0; i < iterations; i++) {
    if (samples.length >= 5 && performance.now() > deadline) break;
    setup?.();
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(samples.length / 2)],
    p90: samples[Math.floor(samples.length * 0.9)],
    runs: samples.length,
  };
}

const fmt = (r: { median: number; p90: number; runs: number }) =>
  `${r.median.toFixed(1)} ms (p90 ${r.p90.toFixed(1)}, n=${r.runs})`;

interface Pipeline {
  setData(data: SyntheticPod[]): void;
  setFilter(query: string): void;
  setSorting(state: { id: string; desc: boolean }[]): void;
  rows(): Row<SyntheticPod>[];
  memo?: Map<string, SyntheticPod>;
}

/* The VirtualDataTable pipeline (useTableModel). */
function createPipeline(): Pipeline {
  const data = shallowRef<SyntheticPod[]>([]);
  const query = ref("");
  const sorting = ref<{ id: string; desc: boolean }[]>([]);
  const allColumns = [
    { id: "select", size: 32, enableHiding: false, cell: () => null },
    ...columns,
  ] as ColumnDef<SyntheticPod, any>[];
  const model = useTableModel<SyntheticPod>({
    data: () => data.value,
    columns: () => allColumns,
    query: () => query.value,
    sorting,
  });
  return {
    setData: (rows) => (data.value = rows),
    setFilter: (q) => (query.value = q),
    setSorting: (s) => (sorting.value = s),
    rows: () => model.filteredRows.value,
    memo: new Map(),
  };
}

const pipelines: Record<string, () => Pipeline> = {
  baseline: () => createBaselinePipeline(columns),
  table: createPipeline,
};

describe("table pipeline", () => {
  test("filters and sorts like the TanStack baseline", () => {
    const pods = syntheticPods(250);
    for (const sorting of [[], [{ id: "metadata_name", desc: true }]]) {
      for (const query of ["", "pay", "PAYMENTS-API-1", "10.0.1", "zzz"]) {
        const a = createBaselinePipeline(columns);
        const b = createPipeline();
        for (const p of [a, b]) {
          p.setSorting(sorting);
          p.setData(pods);
          p.setFilter(query);
        }
        expect(b.rows().map((r) => r.id)).toEqual(a.rows().map((r) => r.id));
      }
    }
  }, 60000);

  test("refresh reuses unchanged rows and picks up changed ones", () => {
    const pods = syntheticPods(200);
    const p = createPipeline();
    p.setData(pods);
    const before = new Map(p.rows().map((r) => [r.id, r]));
    const next = refreshedPods(pods, 0.05, 0);
    p.setData(next);
    let reused = 0;
    for (const row of p.rows()) {
      const old = before.get(row.id)!;
      const fresh = next[row.index];
      if (row === old) {
        reused++;
        expect(old.original.metadata.resourceVersion).toBe(
          fresh.metadata.resourceVersion
        );
      } else {
        expect(row.original).toBe(fresh);
        expect(row.getValue("Restarts")).toBe(getPodRestarts(fresh as any));
      }
    }
    expect(reused).toBe(190);
  });
});

describe.runIf(process.env.BENCH)("table benchmarks", () => {
  for (const size of [5000, 20000]) {
    test(`${size} pods`, () => {
      const initial = syntheticPods(size);
      const refreshes: SyntheticPod[][] = [];
      let previous = initial;
      for (let round = 0; round < 8; round++) {
        previous = refreshedPods(previous, 0.01, round);
        refreshes.push(previous);
      }

      for (const [name, create] of Object.entries(pipelines)) {
        const filtering = create();
        filtering.setData(initial);
        let k = 0;
        const keystroke = measure(() => {
          filtering.setFilter(keystrokes[k++ % keystrokes.length]);
          renderWindow(filtering.rows(), filtering.memo);
        }, 60);

        /* First keystroke after a refresh: new rows, cold caches. */
        const cold = create();
        cold.setData(initial);
        let c = 0;
        const keystrokeCold = measure(
          () => {
            cold.setFilter(keystrokes[c % keystrokes.length]);
            renderWindow(cold.rows(), cold.memo);
          },
          24,
          () => {
            c++;
            cold.setFilter("");
            cold.setData(refreshes[c % refreshes.length]);
            cold.rows();
          }
        );

        const refreshBench = (sorted: boolean) => {
          const refreshing = create();
          if (sorted) {
            refreshing.setSorting([{ id: "metadata_name", desc: false }]);
          }
          refreshing.setData(initial);
          renderWindow(refreshing.rows(), refreshing.memo);
          let r = 0;
          return measure(() => {
            refreshing.setData(refreshes[r++ % refreshes.length]);
            renderWindow(refreshing.rows(), refreshing.memo);
          }, 24);
        };
        const refresh = refreshBench(false);
        const refreshSorted = refreshBench(true);

        process.stderr.write(
          [
            `[bench] ${size} pods / ${name}`,
            `  keystroke                ${fmt(keystroke)}`,
            `  keystroke after refresh  ${fmt(keystrokeCold)}`,
            `  refresh 1% (unsorted)    ${fmt(refresh)}`,
            `  refresh 1% (sorted)      ${fmt(refreshSorted)}`,
            "",
          ].join("\n")
        );
        expect(filtering.rows().length).toBeGreaterThan(0);
      }
    }, 900000);
  }
});
