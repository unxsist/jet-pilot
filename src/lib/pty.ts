import type { Channel } from "@tauri-apps/api/core";

/** Sent by the backend when the process running in the pty has exited. */
export type PtyExitMessage = {
  type: "exit";
  exitCode: number | null;
  error: string | null;
};

/**
 * Messages on a pty session channel: terminal output as raw bytes (an
 * ArrayBuffer, or a number array on the postMessage IPC fallback) and a
 * final exit message.
 */
export type PtyMessage = ArrayBuffer | number[] | PtyExitMessage;

/** Starts a pty session of the given size and returns its session id. */
export type PtyStarter = (
  size: { rows: number; cols: number },
  onEvent: Channel<PtyMessage>
) => Promise<string>;

export const isPtyExitMessage = (
  message: PtyMessage
): message is PtyExitMessage =>
  !(message instanceof ArrayBuffer) &&
  !Array.isArray(message) &&
  typeof message === "object" &&
  message !== null &&
  message.type === "exit";

/** Terminal output bytes of a channel message, or null for other messages. */
export const ptyOutput = (message: PtyMessage): Uint8Array | null => {
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }

  if (Array.isArray(message)) {
    return Uint8Array.from(message);
  }

  return null;
};

/** xterm needs CRLF line endings for text written directly to it. */
export const toTerminalText = (text: string): string =>
  text.replace(/\r?\n/g, "\r\n");

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;

export const terminalNotice = (text: string): string =>
  dim(toTerminalText(text)) + "\r\n";

export const terminalError = (text: string): string =>
  red(toTerminalText(text)) + "\r\n";

/** Text shown when the session ended, including the restart hint. */
export const exitText = (message: PtyExitMessage): string => {
  const reason = message.error
    ? terminalError(`Terminal process failed: ${message.error}`)
    : terminalNotice(
        message.exitCode === null
          ? "[Process exited]"
          : `[Process exited with code ${message.exitCode}]`
      );

  return "\r\n" + reason + terminalNotice("Press Enter to restart.");
};

/** `kubectl exec` argv for an interactive shell in a container. */
export const kubectlExecCommand = (options: {
  pod: string;
  container: string;
  context: string;
  namespace: string;
  kubeConfig: string;
  shell: string;
}): string[] => [
  "kubectl",
  "exec",
  "--tty",
  "--stdin",
  options.pod,
  "--context",
  options.context,
  "--namespace",
  options.namespace,
  "--kubeconfig",
  options.kubeConfig,
  "-c",
  options.container,
  "--",
  options.shell.trim() || "/bin/sh",
];
