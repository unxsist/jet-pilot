<script setup lang="ts">
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { FitAddon } from "xterm-addon-fit";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useTheme } from "@/providers/ThemeProvider";
import { JET_XTERM } from "@/lib/themes/xtermTheme";
import { TabClosedEvent } from "@/providers/PanelProvider";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { injectStrict } from "@/lib/utils";
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

/*
 * Colours follow the app theme (src/lib/themes/xtermTheme.ts builds them);
 * until the theme engine has loaded, JET's palette for the painted
 * appearance.
 */
const theme = useTheme();
const terminalTheme = () =>
  theme.active.value?.xterm ?? JET_XTERM[theme.appearance.value];

const FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';

/* Settings › Terminal & Editor › Terminal; applied live. */
const { settings } = injectStrict(SettingsContextStateKey);
const preferences = computed(() => settings.value.terminal);
const reducedMotion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const fontFamily = () => preferences.value.fontFamily.trim() || FONT_FAMILY;

const terminal = new Terminal({
  cursorBlink: preferences.value.cursorBlink && !reducedMotion,
  cursorStyle: preferences.value.cursorStyle,
  fontSize: preferences.value.fontSize,
  lineHeight: preferences.value.lineHeight,
  fontFamily: fontFamily(),
  scrollback: preferences.value.scrollback,
  theme: terminalTheme(),
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);

watch(
  () => ({ ...preferences.value }),
  (next, previous) => {
    terminal.options.cursorBlink = next.cursorBlink && !reducedMotion;
    terminal.options.cursorStyle = next.cursorStyle;
    terminal.options.fontSize = next.fontSize;
    terminal.options.lineHeight = next.lineHeight;
    terminal.options.fontFamily = fontFamily();
    if (next.scrollback !== previous.scrollback) terminal.options.scrollback = next.scrollback;
    fit();
  }
);

/* Copy on select (Settings): selections go to the clipboard right away. */
terminal.onSelectionChange(() => {
  if (!preferences.value.copyOnSelect || !terminal.hasSelection()) return;
  writeText(terminal.getSelection()).catch(() => undefined);
});

watch([theme.active, theme.appearance], () => {
  terminal.options.theme = terminalTheme();
});
theme.resolved().then(
  () => (terminal.options.theme = terminalTheme()),
  () => undefined
);

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
  document.fonts?.load(`${preferences.value.fontSize}px ${FONT_FAMILY}`).then(() => {
    if (disposed) return;
    terminal.options.fontFamily = fontFamily();
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
