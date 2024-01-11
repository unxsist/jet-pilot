<script setup lang="ts">
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { FitAddon } from "xterm-addon-fit";
import { invoke } from "@tauri-apps/api/tauri";
import { Event, listen } from "@tauri-apps/api/event";
import { V1Container, V1Pod } from "@kubernetes/client-node";

let terminal: Terminal;
let fitAddon: FitAddon;
const terminalElement = ref<HTMLDivElement | null>(null);
const ttySessionId = ref<string | null>(null);

const props = defineProps<{
  context: string;
  namespace: string;
  pod: V1Pod;
  container?: V1Container;
}>();

const writeToTerminal = (ev: Event<string>) => {
  terminal.write(ev.payload);
};

const writeToPty = (data: string) => {
  invoke("write_to_pty", { sessionId: ttySessionId.value, data });
};

const openTerminal = () => {
  invoke<string>("create_tty_session", {
    initCommand: [
      "kubectl",
      "exec",
      "--tty",
      "--stdin",
      props.pod.metadata?.name as string,
      "--context",
      props.context,
      "--namespace",
      props.namespace,
      "-c",
      props.container
        ? props.container.name
        : (props.pod.spec?.containers?.[0].name as string),
      "--",
      "/bin/bash",
    ],
  }).then((sid: string) => {
    ttySessionId.value = sid;
    listen(`tty_data_${sid}`, writeToTerminal);

    fitAddon = new FitAddon();
    terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "monospace",
      theme: {
        background: "#000000",
        foreground: "#ffffff",
      },
    });

    terminal.onData(writeToPty);
    terminal.loadAddon(fitAddon);
    terminal.open(terminalElement.value!);
    fitAddon.fit();
    terminal.focus();
  });
};

const kill = () => {
  invoke("stop_tty_session", { sessionId: ttySessionId.value });
};

const resize = () => {
  fitAddon.fit();
};

onMounted(() => {
  openTerminal();

  window.addEventListener("TabOrchestrator_Resized", resize);
  window.addEventListener("resize", resize);
});

onUnmounted(() => {
  kill();

  window.removeEventListener("TabOrchestrator_Resized", resize);
  window.removeEventListener("resize", resize);
});
</script>

<template>
  <div class="w-full h-full">
    <div ref="terminalElement" class="w-full h-full"></div>
  </div>
</template>
