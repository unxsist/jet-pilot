<script setup lang="ts">
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { FitAddon } from "xterm-addon-fit";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useColorMode } from "@vueuse/core";
import { TabClosedEvent } from "@/providers/PanelProvider";
import { error } from "@/lib/logger";
import {
  PtyMessage,
  PtyStarter,
  exitText,
  isPtyExitMessage,
  ptyOutput,
  terminalError,
  terminalNotice,
} from "@/lib/pty";

/*
 * xterm.js bound to a backend pty session. The session is started through
 * `start` (kubectl exec, local shell, ...); output and the exit of the
 * process arrive on a channel. Start failures and exits are shown in the
 * terminal and Enter restarts the session. The session is stopped when the
 * tab closes (the tab component stays cached by keep-alive, so unmounting
 * alone is not enough).
 */
const props = defineProps<{
  start: PtyStarter;
  banner?: string;
  tabId?: string;
}>();

const colorMode = useColorMode();

/*
 * ANSI palettes tuned to the design tokens: the canvas matches
 * --background, the accent cursor / selection match --primary and the
 * normal colours reuse the status hues.
 */
const DARK_THEME = {
  background: "#101011",
  foreground: "#e4e4e8",
  cursor: "#a5a8fb",
  cursorAccent: "#101011",
  selectionBackground: "rgba(97, 90, 237, 0.35)",
  black: "#27272a",
  red: "#f26464",
  green: "#36c984",
  yellow: "#f6ae31",
  blue: "#54a0f8",
  magenta: "#c084fc",
  cyan: "#3cc8de",
  white: "#d4d4d8",
  brightBlack: "#5c5c66",
  brightRed: "#f88a8a",
  brightGreen: "#5edc9e",
  brightYellow: "#f9c45e",
  brightBlue: "#7fb8fb",
  brightMagenta: "#d4a5fd",
  brightCyan: "#6fdcec",
  brightWhite: "#fafafa",
};

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#17171c",
  cursor: "#5048e5",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(80, 72, 229, 0.2)",
  black: "#18181b",
  red: "#ca2121",
  green: "#117948",
  yellow: "#aa5409",
  blue: "#1160d0",
  magenta: "#8b3fd9",
  cyan: "#0e7490",
  white: "#a1a1aa",
  brightBlack: "#71717a",
  brightRed: "#dc2626",
  brightGreen: "#15803d",
  brightYellow: "#b45309",
  brightBlue: "#2563eb",
  brightMagenta: "#a855f7",
  brightCyan: "#0891b2",
  brightWhite: "#d4d4d8",
};

const theme = (mode: string) => (mode === "dark" ? DARK_THEME : LIGHT_THEME);

const FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

const terminal = new Terminal({
  cursorBlink: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  cursorStyle: "bar",
  fontSize: 13,
  lineHeight: 1.25,
  fontFamily: FONT_FAMILY,
  theme: theme(colorMode.value),
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);

watch(colorMode, (value) => {
  terminal.options.theme = theme(value);
});

const terminalElement = ref<HTMLDivElement | null>(null);

let sessionId: string | null = null;
let channel: Channel<PtyMessage> | null = null;
let status: "starting" | "running" | "exited" = "starting";
// Input typed (or terminal replies such as cursor position reports) before
// the session id is known.
let pendingInput = "";
let disposed = false;
let resizeObserver: ResizeObserver | null = null;

const writeToPty = (data: string) => {
  if (!sessionId) return;

  invoke("write_to_pty", { sessionId, data }).catch((e) =>
    error(`Failed to write to terminal: ${e}`)
  );
};

const resizePty = () => {
  if (!sessionId) return;

  invoke("resize_pty", {
    sessionId,
    rows: terminal.rows,
    cols: terminal.cols,
  }).catch((e) => error(`Failed to resize terminal: ${e}`));
};

const stopSession = () => {
  channel = null;
  if (!sessionId) return;

  const id = sessionId;
  sessionId = null;
  invoke("stop_tty_session", { sessionId: id }).catch((e) =>
    error(`Failed to stop terminal session: ${e}`)
  );
};

const handleMessage = (source: Channel<PtyMessage>, message: PtyMessage) => {
  // Late messages of a stopped / restarted session.
  if (source !== channel) return;

  const output = ptyOutput(message);
  if (output) {
    terminal.write(output);
    return;
  }

  if (isPtyExitMessage(message)) {
    status = "exited";
    sessionId = null;
    channel = null;
    terminal.write(exitText(message));
  }
};

const startSession = async () => {
  status = "starting";
  pendingInput = "";

  const sessionChannel = new Channel<PtyMessage>();
  sessionChannel.onmessage = (message) =>
    handleMessage(sessionChannel, message);
  channel = sessionChannel;

  try {
    const id = await props.start(
      { rows: terminal.rows, cols: terminal.cols },
      sessionChannel
    );

    // Disposed, restarted, or the process already exited (which resets the
    // channel) while the session was starting.
    if (disposed || channel !== sessionChannel) {
      invoke("stop_tty_session", { sessionId: id }).catch(() => {});
      return;
    }

    sessionId = id;
    status = "running";

    if (pendingInput) {
      writeToPty(pendingInput);
      pendingInput = "";
    }

    // The terminal may have been resized while the session was starting.
    resizePty();
  } catch (e) {
    if (channel !== sessionChannel) return;

    channel = null;
    status = "exited";
    terminal.write(terminalError(`Failed to start terminal: ${e}`));
    terminal.write(terminalNotice("Press Enter to retry."));
  }
};

terminal.onData((data) => {
  if (status === "running") {
    writeToPty(data);
  } else if (status === "starting") {
    pendingInput += data;
  } else if (data.includes("\r")) {
    terminal.reset();
    startSession();
  }
});

terminal.onResize(() => resizePty());

const fit = () => {
  const element = terminalElement.value;
  // Detached (inactive keep-alive tab) or collapsed panel.
  if (!element || element.offsetWidth === 0 || element.offsetHeight === 0) {
    return;
  }

  fitAddon.fit();
};

const dispose = () => {
  if (disposed) return;
  disposed = true;

  stopSession();
  resizeObserver?.disconnect();
  window.removeEventListener("TabOrchestrator_TabClosed", handleTabClosed);
  terminal.dispose();
};

const handleTabClosed = (e: Event) => {
  const event = e as CustomEvent<TabClosedEvent>;
  if (props.tabId && event.detail.id === props.tabId) {
    dispose();
  }
};

onMounted(() => {
  terminal.open(terminalElement.value!);
  fit();

  // The bundled mono font may still be loading: re-measure once it is.
  document.fonts?.load(`13px ${FONT_FAMILY}`).then(() => {
    if (disposed) return;
    terminal.options.fontFamily = FONT_FAMILY;
    fit();
  });

  if (props.banner) {
    terminal.write(terminalNotice(props.banner));
  }

  startSession();
  terminal.focus();

  resizeObserver = new ResizeObserver(() => fit());
  resizeObserver.observe(terminalElement.value!);
  window.addEventListener("TabOrchestrator_TabClosed", handleTabClosed);
});

onActivated(() => {
  if (disposed) return;

  fit();
  terminal.focus();
});

onUnmounted(() => {
  dispose();
});
</script>

<template>
  <div class="h-full w-full bg-background py-2 pl-3 pr-1">
    <div ref="terminalElement" class="h-full w-full"></div>
  </div>
</template>
