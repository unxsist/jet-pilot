/*
 * Operator actions, from table rows and side panels alike: renew a
 * cert-manager Certificate, sync an ExternalSecret now, pause / resume KEDA
 * autoscaling. Every change goes through the guardrails and a patch over
 * the raw API (`kubePatch`).
 */
import { toast } from "@/components/ui/toast";
import { confirmDialog, guard, rowTargets } from "@/lib/guardrails/guard";
import { apiPath, kubePatch } from "@/lib/kubeApi";
import { formatResourceKind } from "@/lib/utils";
import type { BaseDialogInterface } from "@/providers/DialogProvider";
import { renewPatch } from "./certManager";
import { forceSyncPatch } from "./externalSecrets";
import { pausePatch } from "./keda";

type SpawnDialog = (dialog: BaseDialogInterface) => void;

interface Row {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; namespace?: string; context?: string; kubeConfig?: string };
}

const target = (row: Row) => ({
  context: row.metadata?.context ?? "",
  kubeConfig: row.metadata?.kubeConfig,
});

const pathOf = (row: Row, subresource?: string) =>
  apiPath({
    apiVersion: row.apiVersion ?? "",
    resource: formatResourceKind(row.kind ?? "").toLowerCase(),
    namespace: row.metadata?.namespace,
    name: row.metadata?.name,
    subresource,
  });

const errorText = (error: unknown) =>
  (error as { message?: string })?.message ?? String(error);

async function patch(
  row: Row,
  body: unknown,
  messages: { done: string; description?: string; failed: string },
  subresource?: string
): Promise<boolean> {
  try {
    await kubePatch(target(row), pathOf(row, subresource), body);
    toast({
      title: messages.done,
      description: messages.description,
      variant: "success",
      autoDismiss: true,
    });
    return true;
  } catch (error) {
    toast({
      title: messages.failed,
      description: errorText(error),
      variant: "destructive",
      duration: 15000,
    });
    return false;
  }
}

/** Asks cert-manager to issue the certificate again (like `cmctl renew`). */
export async function renewCertificate(cert: Row): Promise<boolean> {
  if (!(await guard("renew", rowTargets([cert])))) return false;
  const name = cert.metadata?.name;
  return patch(
    cert,
    renewPatch(cert),
    {
      done: `Renewing ${name}`,
      description: "cert-manager issues a new certificate in a moment.",
      failed: `Couldn't renew ${name}`,
    },
    "status"
  );
}

/** Makes External Secrets refresh the secret from its store now. */
export async function syncExternalSecret(secret: Row): Promise<boolean> {
  if (!(await guard("force-sync", rowTargets([secret])))) return false;
  const name = secret.metadata?.name;
  return patch(secret, forceSyncPatch(), {
    done: `Syncing ${name}`,
    description: "External Secrets fetches it from the store now.",
    failed: `Couldn't sync ${name}`,
  });
}

/** Pauses (after a confirmation) or resumes KEDA autoscaling. */
export async function setAutoscalingPaused(
  object: Row,
  paused: boolean,
  spawnDialog: SpawnDialog
): Promise<boolean> {
  const name = object.metadata?.name;
  const allowed = await guard(paused ? "pause" : "resume", rowTargets([object]), {
    confirm: paused
      ? () =>
          confirmDialog(spawnDialog, {
            title: `Pause autoscaling of ${name}?`,
            message: "KEDA stops scaling it: the replicas stay as they are until you resume.",
            confirmLabel: "Pause",
          })
      : undefined,
  });
  if (!allowed) return false;
  return patch(object, pausePatch(paused), {
    done: paused ? `Paused ${name}` : `Resumed ${name}`,
    description: paused ? "Autoscaling is off until you resume it." : "KEDA scales it again.",
    failed: paused ? `Couldn't pause ${name}` : `Couldn't resume ${name}`,
  });
}
