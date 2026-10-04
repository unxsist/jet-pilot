import { test, assert, describe } from "vitest";
import {
  exitText,
  isPtyExitMessage,
  kubectlExecCommand,
  ptyOutput,
  terminalError,
  toTerminalText,
} from "../../src/lib/pty";

describe("pty messages", () => {
  test("raw output as ArrayBuffer", () => {
    const output = ptyOutput(new Uint8Array([104, 105]).buffer);
    assert.deepEqual(Array.from(output!), [104, 105]);
  });

  test("raw output as number array (postMessage fallback)", () => {
    assert.deepEqual(Array.from(ptyOutput([104, 105])!), [104, 105]);
  });

  test("exit message", () => {
    const exit = { type: "exit" as const, exitCode: 0, error: null };
    assert.isTrue(isPtyExitMessage(exit));
    assert.isNull(ptyOutput(exit));
    assert.isFalse(isPtyExitMessage(new ArrayBuffer(1)));
    assert.isFalse(isPtyExitMessage([1]));
  });
});

describe("terminal text", () => {
  test("uses CRLF line endings", () => {
    assert.equal(toTerminalText("a\nb\r\nc"), "a\r\nb\r\nc");
  });

  test("errors are red", () => {
    assert.equal(terminalError("boom"), "\x1b[31mboom\x1b[0m\r\n");
  });

  test("exit text mentions the code or the error and how to restart", () => {
    const exited = exitText({ type: "exit", exitCode: 130, error: null });
    assert.include(exited, "[Process exited with code 130]");
    assert.include(exited, "Press Enter to restart.");

    const failed = exitText({ type: "exit", exitCode: null, error: "gone" });
    assert.include(failed, "Terminal process failed: gone");
  });
});

describe("kubectlExecCommand", () => {
  const options = {
    pod: "web-0",
    container: "app",
    context: "prod",
    namespace: "shop",
    kubeConfig: "/home/me/.kube/config",
    shell: "/bin/bash",
  };

  test("runs the configured shell in the container", () => {
    assert.deepEqual(kubectlExecCommand(options), [
      "kubectl",
      "exec",
      "--tty",
      "--stdin",
      "web-0",
      "--context",
      "prod",
      "--namespace",
      "shop",
      "--kubeconfig",
      "/home/me/.kube/config",
      "-c",
      "app",
      "--",
      "/bin/bash",
    ]);
  });

  test("falls back to /bin/sh when no shell is configured", () => {
    const argv = kubectlExecCommand({ ...options, shell: " " });
    assert.equal(argv[argv.length - 1], "/bin/sh");
  });
});
