/*
 * The fixes and shortcuts of a problem. Every change runs the guardrails
 * first (read-only clusters block it, protected ones ask for the typed
 * confirmation); changes to a spec go through a dialog that previews them
 * with a server-side dry run and says when GitOps or Helm would undo them.
 */
import { defineAsyncComponent, markRaw } from "vue";
import { toast } from "@/components/ui/toast";
import { runCliForEach } from "@/actions/command";
import { confirmDialog, guard } from "@/lib/guardrails/guard";
import { apiPath, kubeDelete, kubePost } from "@/lib/kubeApi";
import { clusterArgs } from "@/lib/workloads";
import { rolloutArgs } from "@/lib/rollout";
import { followRef, fetchRef } from "@/lib/resources/open";
import { formatResourceKind } from "@/lib/utils";
import { listWords, plural } from "@/lib/resources/format";
import { Kubernetes } from "@/services/Kubernetes";
import type { AskAi } from "@/lib/ai/askAi";
import type { BaseDialogInterface } from "@/providers/DialogProvider";
import type { SidePanel } from "@/providers/PanelProvider";
import { fetchSubject, kubeTarget, type LogSource } from "./evidence";
import { retryJob } from "./fixes";
import { podsWords } from "./group";
import { KINDS, type Problem } from "./model";

type SpawnDialog = (dialog: BaseDialogInterface) => void;
type AddTab = (id: string, title: string, component: any, props?: any, icon?: string) => void;

const RaiseMemory = markRaw(defineAsyncComponent(() => import("@/views/health/problems/RaiseMemoryDialog.vue")));
const Rollback = markRaw(defineAsyncComponent(() => import("@/views/health/problems/RollbackDialog.vue")));
const DeletePod = markRaw(defineAsyncComponent(() => import("@/views/dialogs/DeletePod.vue")));
const StructuredLogViewer = markRaw(defineAsyncComponent(() => import("@/views/StructuredLogViewer.vue")));

const subjectTarget = (problem: Problem) => ({
  context: problem.context,
  kubeConfig: problem.kubeConfig,
  name: problem.subject.name,
  kind: problem.subject.kind,
  namespace: problem.namespace,
});

const failed = (title: string, e: unknown) =>
  toast({ title, description: (e as { message?: string })?.message ?? String(e), variant: "destructive" });

/** `kubectl rollout restart`: every pod replaced through a rolling update. */
export async function restart(problem: Problem, spawnDialog: SpawnDialog) {
  const { kind, name } = problem.subject;
  const confirmed = await guard("restart", [subjectTarget(problem)], {
    confirm: () =>
      confirmDialog(spawnDialog, {
        title: `Restart ${name}?`,
        message: "All pods are replaced through a rolling update, following the update strategy. It helps when they're stuck, not when the new version is broken.",
        confirmLabel: "Restart",
      }),
  });
  if (!confirmed) return;
  await runCliForEach("kubectl", [problem], {
    args: () => [...rolloutArgs("restart", kind, name), ...clusterArgs({ ...problem, namespace: problem.namespace ?? "" })],
    label: () => name,
    successVerb: "Restarted",
    failureVerb: "restart",
    guarded: true,
  });
}

/** Roll back to the previous revision: a dialog with what changes, and a copy of it for Git. */
export function rollback(problem: Problem, spawnDialog: SpawnDialog) {
  spawnDialog({
    title: `Roll back ${problem.subject.name}?`,
    message: "Its pods are replaced with those of the previous revision, through a rolling update.",
    component: Rollback,
    props: { problem },
  });
}

/** Raise the memory limit of the container that ran out of it, previewed with a dry run. */
export function raiseMemory(problem: Problem, spawnDialog: SpawnDialog) {
  const finding = problem.findings.find((f) => f.kind === "oom" && f.memoryLimit);
  spawnDialog({
    title: `Raise the memory limit of ${problem.subject.name}?`,
    message: `${finding?.container ?? "A container"} ran out of memory at its ${finding?.memoryLimit ?? ""} limit. Its pods are replaced to get the new one.`,
    component: RaiseMemory,
    props: { problem },
  });
}

/** Run a failed Job again: a CronJob is triggered, a Job copied. */
export async function retry(problem: Problem, spawnDialog: SpawnDialog) {
  const { name } = problem.subject;
  const cronJob = problem.subject.kind === "CronJob";
  const confirmed = await guard(cronJob ? "cronjob-trigger" : "retry-job", [subjectTarget(problem)], {
    confirm: () =>
      confirmDialog(spawnDialog, {
        title: cronJob ? `Run ${name} now?` : `Retry ${name}?`,
        message: cronJob
          ? "A job is created from the cron job, the way its schedule would."
          : "A new job with the same spec is created. The failed one stays, with its pods and logs.",
        confirmLabel: cronJob ? "Run now" : "Retry",
      }),
  });
  if (!confirmed) return;
  try {
    if (cronJob) {
      await Kubernetes.triggerCronJob(problem.context, problem.namespace ?? "", name, problem.kubeConfig, { guarded: true });
    } else {
      const job = await fetchSubject(problem);
      if (!job) throw new Error(`Job ${name} doesn't exist anymore.`);
      await kubePost(kubeTarget(problem), apiPath({ apiVersion: "batch/v1", resource: "jobs", namespace: problem.namespace }), retryJob(job));
    }
    toast({ title: cronJob ? `Started ${name}` : `Retrying ${name}`, description: "A new job was created.", variant: "success", autoDismiss: true });
  } catch (e) {
    failed(cronJob ? `Couldn't run ${name}` : `Couldn't retry ${name}`, e);
  }
}

/** Delete a pod stuck terminating: the pod dialog, with force delete. */
export async function deleteStuckPod(problem: Problem, spawnDialog: SpawnDialog) {
  const finding = problem.findings.find((f) => f.object.kind === "Pod");
  if (!finding) return;
  try {
    const pod = await fetchRef({ context: problem.context, kubeConfig: problem.kubeConfig }, finding.object);
    if (!pod) {
      toast({ title: `${finding.object.name} is gone`, description: "The pod was deleted in the meantime.", variant: "success", autoDismiss: true });
      return;
    }
    spawnDialog({
      title: `Delete ${finding.object.name}?`,
      message: "It's past its grace period. A force delete removes it from the API right away, even if its node never confirms it stopped.",
      component: DeletePod,
      props: { pod },
    });
  } catch (e) {
    failed(`Couldn't open ${finding.object.name}`, e);
  }
}

/** Clean up evicted pods: they hold no resources, only clutter. */
export async function deleteEvicted(problem: Problem, spawnDialog: SpawnDialog) {
  const pods = problem.findings.filter((f) => f.kind === "evicted").map((f) => f.object);
  const targets = pods.map((pod) => ({ context: problem.context, kubeConfig: problem.kubeConfig, name: pod.name, kind: "Pod", namespace: pod.namespace }));
  const confirmed = await guard("delete", targets, {
    confirm: () =>
      confirmDialog(spawnDialog, {
        title: `Delete ${plural(pods.length, "evicted pod")}?`,
        message: "Evicted pods don't run or hold resources; they stay only to show what happened. Their workload already replaced them.",
        confirmLabel: "Delete",
        variant: "destructive",
      }),
  });
  if (!confirmed) return;
  const results = await Promise.allSettled(
    pods.map((pod) => kubeDelete(kubeTarget(problem), apiPath({ apiVersion: "v1", resource: "pods", namespace: pod.namespace, name: pod.name })))
  );
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) failed(`Couldn't delete ${plural(failures.length, "pod")}`, (failures[0] as PromiseRejectedResult).reason);
  else toast({ title: `Deleted ${plural(pods.length, "evicted pod")}`, variant: "success", autoDismiss: true });
}

/** Opens the logs that explain a problem (the crashed instance for crashes) in a tab. */
export function openLogs(problem: Problem, source: LogSource, addTab: AddTab) {
  addTab(
    ["logs", problem.context, source.pod.namespace, "Pod", source.pod.name, source.previous ? "previous" : ""].join("_"),
    source.pod.name,
    StructuredLogViewer,
    {
      context: problem.context,
      namespace: source.pod.namespace ?? "",
      kubeConfig: problem.kubeConfig,
      object: source.pod.name,
      ...(source.container ? { container: source.container } : {}),
      previous: source.previous,
    },
    "logs"
  );
}

/** Opens the object a problem is named after in the side panel (Back returns to the problem). */
export function openSubject(problem: Problem, setSidePanel: (panel: SidePanel | null) => void, current: SidePanel | null) {
  return followRef(setSidePanel, current, { context: problem.context, kubeConfig: problem.kubeConfig }, problem.subject);
}

export const subjectIcon = (problem: Problem) => formatResourceKind(problem.subject.kind).toLowerCase();

/** "Why does checkout-api keep crashing?" */
export function question(problem: Problem): string {
  const name = problem.subject.name;
  switch (problem.kind) {
    case "oom":
      return `Why does ${name} run out of memory, and what limit does it need?`;
    case "crashloop":
      return `Why does ${name} keep crashing?`;
    case "image-pull":
      return `Why can't the image of ${name} be pulled?`;
    case "config":
      return `What configuration is ${name} missing?`;
    case "unschedulable":
    case "pvc-pending":
      return `Why can't ${name} be scheduled?`;
    case "probe":
      return `Why isn't ${name} ready?`;
    case "node-not-ready":
    case "node-pressure":
      return `What's wrong with node ${name}?`;
    case "job-failed":
    case "cronjob-failed":
      return `Why did ${name} fail?`;
    default:
      return `What's wrong with ${name} (${KINDS[problem.kind].label.toLowerCase()})?`;
  }
}

/** Hands the problem to the user's AI agent, with what JET Pilot already knows. */
export function askAbout(problem: Problem, askAi: AskAi, extra: string[] = []) {
  const findings = problem.findings.slice(0, 6).map((f) => {
    const where = f.object.kind === "Pod" ? `pod ${f.object.name}${f.container ? `, container ${f.container}` : ""}` : `${f.object.kind} ${f.object.name}`;
    return `${f.label ?? KINDS[f.kind].label} (${where}): ${f.short}${f.message && f.message !== f.short ? `. ${f.message}` : ""}`;
  });
  const pods = podsWords(problem);
  askAi.ask({
    context: problem.context,
    kubeConfig: problem.kubeConfig,
    namespace: problem.namespace,
    subject: `${problem.subject.name} (${problem.subject.kind})`,
    question: question(problem),
    evidence: [
      `${problem.subject.kind} ${problem.subject.name}${problem.namespace ? ` in namespace ${problem.namespace}` : ""}: ${problem.label}${pods ? `, ${pods.toLowerCase()}` : ""}.`,
      ...findings,
      ...extra,
      ...(problem.findings.length > 6 ? [`And ${listWords([plural(problem.findings.length - 6, "more finding")])}.`] : []),
    ],
  });
}
