import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { describeRows, getResourceTabId } from "@/components/tables/identity";
import { allowed, confirmDialog, guard, rowTargets } from "@/lib/guardrails/guard";
import { runCliForEach } from "./command";
import type { HelmReleaseRow } from "@/lib/helm";

/*
 * Helm release actions, shared by the releases table and the release
 * panel. Release rows are not Kubernetes objects; they carry the cluster
 * they were read from in `metadata`.
 */
type ReleaseRef = Pick<
  HelmReleaseRow,
  "name" | "namespace" | "revision" | "chart" | "chartVersion" | "appVersion" | "status" | "metadata"
>;

const tabProps = (row: ReleaseRef) => ({
  context: row.metadata.context,
  namespace: row.namespace,
  kubeConfig: row.metadata.kubeConfig,
  release: {
    name: row.name,
    namespace: row.namespace,
    chart: row.chart,
    chartVersion: row.chartVersion,
    appVersion: row.appVersion,
    revision: row.revision,
    status: row.status,
  },
});

export function openUpgrade(addTab: any, row: ReleaseRef) {
  if (!allowed("helm-upgrade", rowTargets([row], "release"))) return;
  addTab(
    getResourceTabId("helm-upgrade", row),
    `${row.name} upgrade`,
    defineAsyncComponent(() => import("@/views/HelmUpgrade.vue")),
    tabProps(row),
    "helm"
  );
}

/** The revision comparison tab, optionally on two given revisions. */
export function openHistory(
  addTab: any,
  row: ReleaseRef,
  compare?: { revision: number; base: number; show?: "values" | "manifest" }
) {
  addTab(
    getResourceTabId("helm-history", row),
    `${row.name} history`,
    defineAsyncComponent(() => import("@/views/HelmHistory.vue")),
    { ...tabProps(row), compare },
    "history"
  );
}

export function openRollback(spawnDialog: any, row: ReleaseRef) {
  // The dialog asks for the typed confirmation when rolling back.
  if (!allowed("helm-rollback", rowTargets([row], "release"))) return;
  spawnDialog({
    title: `Roll back ${row.name}`,
    message: "Re-deploys an earlier revision as a new one.",
    component: defineAsyncComponent(() => import("@/views/dialogs/HelmRollback.vue")),
    props: tabProps(row),
    buttons: [],
  });
}

/** Rolls back to `revision` after a confirmation; resolves to whether it ran and succeeded. */
export async function rollbackRelease(
  spawnDialog: any,
  row: ReleaseRef,
  revision: { revision: number; chart: string; chartVersion: string; appVersion: string }
): Promise<boolean> {
  const confirmed = await guard("helm-rollback", rowTargets([row], "release"), {
    confirm: () =>
      confirmDialog(spawnDialog, {
        title: `Roll back ${row.name} to revision ${revision.revision}?`,
        message: `Re-deploys ${[revision.chart, revision.chartVersion].filter(Boolean).join(" ")}${
          revision.appVersion ? ` (app ${revision.appVersion})` : ""
        } with the values of revision ${revision.revision}, as a new revision.`,
        confirmLabel: `Roll back to #${revision.revision}`,
      }),
  });
  if (!confirmed) return false;
  const { succeeded } = await runCliForEach("helm", [revision], {
    args: (r) => [
      "rollback",
      row.name,
      String(r.revision),
      `--kube-context=${row.metadata.context}`,
      `--namespace=${row.namespace}`,
      ...(row.metadata.kubeConfig ? [`--kubeconfig=${row.metadata.kubeConfig}`] : []),
    ],
    label: (r) => `${row.name} to revision ${r.revision}`,
    successVerb: "Rolled back",
    failureVerb: "roll back",
    guarded: true,
  });
  return succeeded.length > 0;
}

/** Uninstalls after a confirmation; resolves to the rows uninstalled. */
export async function uninstallReleases(spawnDialog: any, rows: ReleaseRef[]): Promise<ReleaseRef[]> {
  const confirmed = await guard("helm-uninstall", rowTargets(rows, "release"), {
    confirm: () =>
      confirmDialog(spawnDialog, {
        title:
          rows.length === 1
            ? `Uninstall ${rows[0].name}?`
            : `Uninstall ${rows.length} releases?`,
        message:
          "Every Kubernetes object of the release is deleted, and its history with it. This can't be undone.",
        component: defineAsyncComponent(() => import("@/views/dialogs/ResourceList.vue")),
        props: {
          lines: describeRows(rows),
        },
        confirmLabel: "Uninstall",
        variant: "destructive",
      }),
  });
  if (!confirmed) return [];
  const { succeeded } = await runCliForEach("helm", rows, {
    args: (row) => [
      "uninstall",
      row.name,
      `--kube-context=${row.metadata.context}`,
      `--namespace=${row.namespace}`,
      ...(row.metadata.kubeConfig ? [`--kubeconfig=${row.metadata.kubeConfig}`] : []),
    ],
    label: (row) => row.name,
    successVerb: "Uninstalled",
    failureVerb: "uninstall",
    guarded: true,
  });
  return succeeded;
}

export function actions(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  _router: Router
): RowAction<HelmReleaseRow>[] {
  return [
    {
      label: "View details",
      handler: async (row: HelmReleaseRow) => {
        const { openHelmReleasePanel } = await import("@/views/helm/panel");
        openHelmReleasePanel(setSidePanelComponent, row);
      },
    },
    {
      label: "Upgrade",
      kind: "helm-upgrade",
      handler: (row: HelmReleaseRow) => openUpgrade(addTab, row),
    },
    {
      label: "Rollback",
      kind: "helm-rollback",
      isAvailable: (row) => Number(row.revision) > 1,
      handler: (row: HelmReleaseRow) => openRollback(spawnDialog, row),
    },
    {
      label: "History",
      handler: (row: HelmReleaseRow) => openHistory(addTab, row),
    },
    {
      label: "Uninstall",
      kind: "helm-uninstall",
      massAction: true,
      handler: (rows: HelmReleaseRow[]) => uninstallReleases(spawnDialog, rows),
    },
  ];
}
