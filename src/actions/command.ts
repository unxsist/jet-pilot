import { Command } from "@tauri-apps/plugin-shell";
import { toast } from "@/components/ui/toast";
import { error as logError } from "@/lib/logger";

export interface CliResult {
  /** Process exit code; null when the process could not be started. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/*
 * Runs kubectl / helm to completion. Success is decided by the exit code (from
 * the process `close` event), not by output on stderr: kubectl and helm also
 * write warnings / progress there.
 */
export async function runCli(
  program: "kubectl" | "helm",
  args: string[]
): Promise<CliResult> {
  try {
    const { code, stdout, stderr } = await Command.create(
      program,
      args
    ).execute();
    return { code, stdout, stderr };
  } catch (e) {
    return { code: null, stdout: "", stderr: String(e) };
  }
}

/*
 * `helm upgrade|template|diff upgrade ... --values <tmp>`: the backend writes
 * `values` to an owner-only temp file for the duration of the command.
 */
export async function runHelmWithValues(
  args: string[],
  values: string
): Promise<CliResult> {
  try {
    const { Kubernetes } = await import("@/services/Kubernetes");
    return await Kubernetes.runHelmWithValues(args, values);
  } catch (e) {
    return { code: null, stdout: "", stderr: String(e) };
  }
}

export const cliSucceeded = (result: CliResult) => result.code === 0;

export const cliErrorMessage = (result: CliResult) =>
  result.stderr.trim() ||
  (result.code === null
    ? "The command could not be started"
    : `Exited with code ${result.code}`);

/* Error toasts stay a while: they carry stderr output worth reading. */
const ERROR_TOAST_DURATION = 15000;

/**
 * Runs one CLI invocation per item (in parallel) and reports the outcome with
 * a single toast: a success summary, or the stderr of every failed item.
 */
export async function runCliForEach<T>(
  program: "kubectl" | "helm",
  items: T[],
  options: {
    args: (item: T) => string[];
    label: (item: T) => string;
    /** e.g. "Deleted", "Drained" */
    successVerb: string;
    /** e.g. "delete", "drain" */
    failureVerb: string;
  }
): Promise<{ succeeded: T[]; failed: T[] }> {
  const results = await Promise.all(
    items.map((item) => runCli(program, options.args(item)))
  );

  const succeeded: T[] = [];
  const failed: { item: T; message: string }[] = [];
  results.forEach((result, i) => {
    if (cliSucceeded(result)) {
      succeeded.push(items[i]);
    } else {
      const message = cliErrorMessage(result);
      logError(
        `Failed to ${options.failureVerb} ${options.label(items[i])}: ${message}`
      );
      failed.push({ item: items[i], message });
    }
  });

  if (succeeded.length > 0) {
    toast({
      title: `${options.successVerb} ${
        succeeded.length === 1
          ? options.label(succeeded[0])
          : `${succeeded.length} items`
      }`,
      description:
        succeeded.length > 1
          ? succeeded.map(options.label).join(", ")
          : undefined,
      autoDismiss: true,
    });
  }

  if (failed.length > 0) {
    toast({
      title: `Failed to ${options.failureVerb} ${
        failed.length === 1 ? options.label(failed[0].item) : `${failed.length} items`
      }`,
      description: failed
        .map((f) =>
          failed.length === 1
            ? f.message
            : `${options.label(f.item)}: ${f.message}`
        )
        .join("; "),
      variant: "destructive",
      duration: ERROR_TOAST_DURATION,
    });
  }

  return { succeeded, failed: failed.map((f) => f.item) };
}
