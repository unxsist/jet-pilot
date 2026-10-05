<script setup lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { V1Container, V1Pod } from "@kubernetes/client-node";
import { KeyRound } from "lucide-vue-next";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import {
  PtyMessage,
  PtyStarter,
  isPtyExitMessage,
  kubectlExecCommand,
  ptyOutput,
} from "@/lib/pty";
import { credential, onRecovered, report, requestSignIn } from "@/lib/auth/center";
import { Button } from "@/components/ui/button";
import ClusterLabel from "@/components/clusters/ClusterLabel.vue";
import PtyTerminal from "@/components/PtyTerminal.vue";
import TerminalClusterBanner from "@/components/guardrails/TerminalClusterBanner.vue";

const { settings } = injectStrict(SettingsContextStateKey);

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  pod: V1Pod;
  container?: V1Container;
  tabId?: string;
}>();

/*
 * A shell that exits because the cluster needs a sign-in (kubectl prints
 * why) gets an overlay: sign in, and the shell reconnects.
 */
const authTarget = { context: props.context, kubeConfig: props.kubeConfig || "" };
const authView = credential(authTarget);
const authExit = ref(false);
/* Bumped to start a fresh terminal. */
const session = ref(0);

const TAIL_CHARS = 4000;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/* Keeps the last output of the session to explain a failed exit. */
const watchExit = (channel: Parameters<PtyStarter>[1]) => {
  let tail = "";
  const decoder = new TextDecoder();
  const forward = channel.onmessage;
  channel.onmessage = (message: PtyMessage) => {
    const output = ptyOutput(message);
    if (output) {
      tail = (tail + decoder.decode(output, { stream: true })).slice(-TAIL_CHARS);
    } else if (isPtyExitMessage(message) && (message.exitCode || message.error)) {
      const text = `${tail.replace(ANSI, "")}\n${message.error ?? ""}`;
      if (report(authTarget, text, "kubectl")) authExit.value = true;
    }
    forward(message);
  };
};

const start: PtyStarter = ({ rows, cols }, onEvent) => {
  watchExit(onEvent);
  return invoke<string>("create_tty_session", {
    initCommand: kubectlExecCommand({
      pod: props.pod.metadata?.name as string,
      container: props.container
        ? props.container.name
        : (props.pod.spec?.containers?.[0].name as string),
      context: props.context,
      namespace: props.namespace,
      kubeConfig: props.kubeConfig,
      shell: settings.value.terminal.containerShell,
    }),
    rows,
    cols,
    onEvent,
  });
};

const reconnect = () => {
  authExit.value = false;
  session.value++;
};

const signInAndReconnect = () => {
  // Signed in elsewhere meanwhile: just reconnect.
  if (!authView.value.needsSignIn) reconnect();
  else void requestSignIn(authTarget);
};

const stopRecovered = onRecovered(authTarget, () => {
  if (authExit.value) reconnect();
});
onUnmounted(stopRecovered);
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <TerminalClusterBanner :context="context" :kube-config="kubeConfig" />
    <div class="relative min-h-0 flex-1">
      <PtyTerminal :key="session" :start="start" :tab-id="tabId" />
      <div
        v-if="authExit"
        class="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-4 backdrop-blur-[2px] animate-fade-in"
        data-testid="shell-auth-overlay"
      >
        <div
          role="alertdialog"
          aria-labelledby="shell-auth-title"
          class="grid w-full max-w-sm justify-items-center gap-3 rounded-xl border bg-popover p-5 text-center shadow-lg"
        >
          <span
            class="flex h-9 w-9 items-center justify-center rounded-full border border-warning/25 bg-warning/10"
          >
            <KeyRound class="h-4 w-4 text-warning" />
          </span>
          <div class="grid gap-1">
            <p id="shell-auth-title" class="text-base font-semibold text-foreground">
              Sign-in needed
            </p>
            <p class="text-sm text-muted-foreground">
              The shell closed because the cluster needs you to sign in again.
            </p>
          </div>
          <ClusterLabel :context="context" :kube-config="kubeConfig" class="text-sm font-medium" />
          <div class="mt-1 flex gap-2">
            <Button variant="ghost" @click="authExit = false">Dismiss</Button>
            <Button :disabled="authView.signingIn" @click="signInAndReconnect">
              {{ authView.signingIn ? "Signing in…" : "Sign in & reconnect" }}
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
