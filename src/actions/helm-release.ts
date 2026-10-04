import { RowAction } from "@/components/tables/types";
import { Router } from "vue-router";
import { DialogInterface } from "@/providers/DialogProvider";
import { describeRows, getResourceTabId } from "@/components/tables/identity";
import { runCliForEach } from "./command";

/*
 * Helm release rows are not Kubernetes objects; they carry the context they
 * were fetched from in `metadata` (injected by HelmResource aggregation).
 */
interface HelmReleaseRow {
  name: string;
  namespace: string;
  /* helm list prints the revision as a string */
  revision: number | string;
  chart: string;
  app_version?: string;
  status: string;
  metadata: { context: string; kubeConfig: string };
}

export function actions(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<HelmReleaseRow>[] {
  return [
    {
      label: "Rollback",
      isAvailable: (row) => Number(row.revision) > 1,
      handler: (row: HelmReleaseRow) => {
        spawnDialog({
          title: "Rollback Helm Release",
          message: "Please select the revision to rollback to",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/HelmRollback.vue")
          ),
          props: {
            context: row.metadata.context,
            namespace: row.namespace,
            kubeConfig: row.metadata.kubeConfig,
            release: row,
          },
          buttons: [],
        });
      },
    },
    {
      label: "Upgrade",
      handler: (row: HelmReleaseRow) => {
        addTab(
          getResourceTabId("helm-upgrade", row),
          `${row.name} upgrade`,
          defineAsyncComponent(() => import("@/views/HelmUpgrade.vue")),
          {
            context: row.metadata.context,
            namespace: row.namespace,
            kubeConfig: row.metadata.kubeConfig,
            release: row,
          },
          "helm"
        );
      },
    },
    {
      label: "History",
      handler: (row: HelmReleaseRow) => {
        addTab(
          getResourceTabId("helm-history", row),
          `${row.name} history`,
          defineAsyncComponent(() => import("@/views/HelmHistory.vue")),
          {
            context: row.metadata.context,
            namespace: row.namespace,
            kubeConfig: row.metadata.kubeConfig,
            release: row,
          },
          "history"
        );
      },
    },
    {
      label: "Delete",
      massAction: true,
      handler: (rows: HelmReleaseRow[]) => {
        spawnDialog({
          title:
            rows.length === 1
              ? `Uninstall release ${rows[0].name}?`
              : `Uninstall ${rows.length} releases?`,
          message:
            "All Kubernetes resources of the release are deleted. This cannot be undone.",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/ResourceList.vue")
          ),
          props: {
            lines: describeRows(rows),
          },
          buttons: [
            {
              label: "Cancel",
              variant: "ghost",
              handler: (dialog: DialogInterface) => {
                dialog.close();
              },
            },
            {
              label: "Uninstall",
              variant: "destructive",
              handler: (dialog: DialogInterface) => {
                dialog.close();
                runCliForEach("helm", rows, {
                  args: (row) => [
                    "uninstall",
                    row.name,
                    "--kube-context",
                    row.metadata.context,
                    "--namespace",
                    row.namespace,
                    ...(row.metadata.kubeConfig
                      ? ["--kubeconfig", row.metadata.kubeConfig]
                      : []),
                  ],
                  label: (row) => row.name,
                  successVerb: "Uninstalled",
                  failureVerb: "uninstall",
                });
              },
            },
          ],
        });
      },
    },
  ];
}
