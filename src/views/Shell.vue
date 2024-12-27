<script setup lang="ts">
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { FitAddon } from "xterm-addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { Event, listen } from "@tauri-apps/api/event";
import { V1Container, V1Pod } from "@kubernetes/client-node";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { injectStrict } from "@/lib/utils";
import { useColorMode } from "@vueuse/core";
const colorMode = useColorMode();

watch(colorMode, (value) => {
  terminal.options.theme = {
    background: value === "dark" ? "#000000" : "#ffffff",
    foreground: value === "dark" ? "#ffffff" : "#000000",
    cursor: value === "dark" ? "#ffffff" : "#000000",
  };
});

let terminal: Terminal;
let fitAddon: FitAddon;
const terminalElement = ref<HTMLDivElement | null>(null);
const ttySessionId = ref<string | null>(null);

const { settings } = injectStrict(SettingsContextStateKey);

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
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
      "--kubeconfig",
      props.kubeConfig,
      "-c",
      props.container
        ? props.container.name
        : (props.pod.spec?.containers?.[0].name as string),
      "--",
      settings.value.shell.executable,
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
        background: colorMode.value === "dark" ? "#000000" : "#ffffff",
        foreground: colorMode.value === "dark" ? "#ffffff" : "#000000",
        cursor: colorMode.value === "dark" ? "#ffffff" : "#000000",
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
