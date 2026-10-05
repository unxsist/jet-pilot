import { V1Node } from "@kubernetes/client-node";
import { RowAction } from "@/components/tables/types";
import { BaseDialogInterface } from "@/providers/DialogProvider";
import { toast } from "@/components/ui/toast";
import { Router } from "vue-router";
import { describeRows } from "@/components/tables/identity";
import { runCliForEach } from "./command";

export function actions<
  T extends V1Node & {
    metadata: { context: string; kubeConfig: string };
  }
>(
  addTab: any,
  spawnDialog: any,
  setSidePanelComponent: any,
  router: Router
): RowAction<T>[] {
  // Cordoning sets spec.unschedulable; NoSchedule taints are used for other
  // purposes too (control-plane / dedicated nodes).
  const isCordoned = (row: T) => row.spec?.unschedulable === true;

  const contextArgs = (row: T) => [
    "--context",
    row.metadata.context,
    ...(row.metadata.kubeConfig ? ["--kubeconfig", row.metadata.kubeConfig] : []),
  ];

  const nodeLabel = (row: T) => `${row.metadata?.name}`;

  return [
    {
      label: "Node shell",
      handler: (row: T) => {
        spawnDialog({
          title: `Shell on node ${row.metadata?.name}`,
          message:
            "Opens a root shell on the node through kubectl debug node.",
          component: defineAsyncComponent(
            () => import("@/views/dialogs/NodeShell.vue")
          ),
          props: {
            context: row.metadata.context,
            kubeConfig: row.metadata.kubeConfig,
            node: row,
            addTab,
          },
          buttons: [],
        });
      },
    },
    {
      label: (row: T) => {
        return isCordoned(row) ? "Uncordon" : "Cordon";
      },
      handler: (row: T) => {
        const cordoned = isCordoned(row);
        const dialog: BaseDialogInterface = {
          title: cordoned ? "Uncordon" : "Cordon",
          message: cordoned
            ? `Are you sure you want to uncordon ${row.metadata?.name}? New pods can be scheduled on it again.`
            : `Are you sure you want to cordon ${row.metadata?.name}? No new pods will be scheduled on it.`,
          buttons: [
            {
              label: "Cancel",
              variant: "ghost",
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: cordoned ? "Uncordon" : "Cordon",
              handler: (dialog) => {
                dialog.close();
                runCliForEach("kubectl", [row], {
                  args: (node) => [
                    cordoned ? "uncordon" : "cordon",
                    `${node.metadata?.name}`,
                    ...contextArgs(node),
                  ],
                  label: nodeLabel,
                  successVerb: cordoned ? "Uncordoned" : "Cordoned",
                  failureVerb: cordoned ? "uncordon" : "cordon",
                });
              },
            },
          ],
        };
        spawnDialog(dialog);
      },
    },
    {
      label: "Drain",
      massAction: true,
      handler: (rows: T[]) => {
        const dialog: BaseDialogInterface = {
          title:
            rows.length === 1
              ? `Drain ${rows[0].metadata?.name}?`
              : `Drain ${rows.length} nodes?`,
          message:
            "All pods (except DaemonSet pods) are evicted, including pods with local (emptyDir) data, which is lost.",
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
              handler: (dialog) => {
                dialog.close();
              },
            },
            {
              label: "Drain",
              variant: "destructive",
              handler: (dialog) => {
                dialog.close();
                toast({
                  title: `Draining ${
                    rows.length === 1 ? rows[0].metadata?.name : `${rows.length} nodes`
                  }…`,
                  autoDismiss: true,
                });
                runCliForEach("kubectl", rows, {
                  args: (row) => [
                    "drain",
                    `${row.metadata?.name}`,
                    "--force",
                    "--ignore-daemonsets",
                    "--delete-emptydir-data",
                    ...contextArgs(row),
                  ],
                  label: nodeLabel,
                  successVerb: "Drained",
                  failureVerb: "drain",
                });
              },
            },
          ],
        };
        spawnDialog(dialog);
      },
    },
  ];
}
