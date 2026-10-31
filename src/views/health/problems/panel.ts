/*
 * Opening a problem in the side panel, and running one of its fixes:
 * shared by the Problems tab and the panel itself.
 */
import { defineAsyncComponent, markRaw } from "vue";
import type { SidePanel } from "@/providers/PanelProvider";
import type { BaseDialogInterface } from "@/providers/DialogProvider";
import { deleteEvicted, deleteStuckPod, raiseMemory, restart, retry, rollback, subjectIcon } from "@/lib/health/problems/actions";
import type { FixId } from "@/lib/health/problems/fixes";
import type { Problem } from "@/lib/health/problems/model";

export const ProblemPanel = markRaw(defineAsyncComponent(() => import("./ProblemPanel.vue")));

export function openProblemPanel(setSidePanel: (panel: SidePanel | null) => void, problem: Problem) {
  setSidePanel({
    title: problem.subject.name,
    overline: `${problem.subject.kind} problem`,
    icon: subjectIcon(problem),
    component: ProblemPanel,
    props: { fingerprint: problem.fingerprint, problem },
  });
}

/** The fingerprint of the problem a side panel shows, if it shows one. */
export const panelProblem = (panel: SidePanel | null): string | null =>
  panel?.component === ProblemPanel ? (panel.props?.fingerprint ?? null) : null;

export function runFix(problem: Problem, fix: FixId, spawnDialog: (dialog: BaseDialogInterface) => void) {
  switch (fix) {
    case "raise-memory":
      return raiseMemory(problem, spawnDialog);
    case "rollback":
      return rollback(problem, spawnDialog);
    case "restart":
      return restart(problem, spawnDialog);
    case "retry":
      return retry(problem, spawnDialog);
    case "delete-pod":
      return deleteStuckPod(problem, spawnDialog);
    case "delete-evicted":
      return deleteEvicted(problem, spawnDialog);
  }
}
