<script setup lang="ts">
/**
 * A login in progress (lib/auth/loginSession.ts): the device code to enter
 * with the domain it belongs to (shown prominently: only enter codes on a
 * page you expect), Open browser, a waiting state, the redacted output and
 * the outcome. Presentational: the owner runs the session and puts Cancel /
 * Retry in its dialog's footer.
 */
import { Check, CheckCircle2, ChevronRight, Copy, ExternalLink, Globe, Loader2, TriangleAlert } from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/button";
import { browserUrl, type LoginViewState } from "@/lib/auth/loginSession";

const props = defineProps<{
  state: LoginViewState;
  /** After "Signed in", e.g. "reconnecting 3 clusters". */
  successDetail?: string;
}>();

const emit = defineEmits<{ (e: "open-url", url: string): void }>();

const url = computed(() => browserUrl(props.state));
const code = computed(() => props.state.deviceCode?.userCode ?? null);
const waiting = computed(() => props.state.phase === "starting" || props.state.phase === "waiting");
const tool = computed(() => props.state.command?.split(/\s+/)[0]?.split(/[\\/]/).pop() ?? null);

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const copyCode = async () => {
  if (!code.value) return;
  try {
    await writeText(code.value);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = false), 1600);
  } catch {
    copied.value = false;
  }
};
onBeforeUnmount(() => clearTimeout(copiedTimer));

/* The code goes to the clipboard too, unless the page link carries it. */
const openBrowser = () => {
  if (!url.value) return;
  if (code.value && !props.state.deviceCode?.verificationUriComplete) void copyCode();
  emit("open-url", url.value);
};

const showOutput = ref(false);
const outputCount = computed(() => props.state.lines.length + props.state.droppedLines);
</script>

<template>
  <div class="grid gap-3" data-testid="login-session">
    <!-- Signed in -->
    <div
      v-if="state.phase === 'succeeded'"
      class="flex flex-col items-center gap-3 rounded-xl bg-muted/50 px-6 py-8 text-center"
      role="status"
    >
      <span class="flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-success">
        <CheckCircle2 class="h-5 w-5" />
      </span>
      <div class="space-y-0.5">
        <p class="text-sm font-medium text-foreground">Signed in</p>
        <p v-if="successDetail" class="text-xs text-muted-foreground">{{ successDetail }}</p>
      </div>
    </div>

    <!-- Failed / cancelled -->
    <div
      v-else-if="state.phase === 'failed' || state.phase === 'cancelled'"
      class="flex gap-3 rounded-xl px-4 py-3.5"
      :class="state.phase === 'failed' ? 'bg-destructive/[0.07]' : 'bg-muted/50'"
      role="alert"
    >
      <TriangleAlert
        class="mt-0.5 h-4 w-4 shrink-0"
        :class="state.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'"
      />
      <div class="min-w-0 space-y-0.5">
        <p class="text-sm font-medium text-foreground">
          {{ state.phase === "failed" ? "Sign-in failed" : "Sign-in cancelled" }}
        </p>
        <p
          v-if="state.error"
          class="max-h-32 overflow-y-auto whitespace-pre-line break-words text-xs text-muted-foreground"
        >
          {{ state.error }}
        </p>
      </div>
    </div>

    <!-- Device code / browser sign-in -->
    <div v-else-if="code || url" class="flex flex-col items-center rounded-xl bg-muted/50 px-6 pb-6 pt-7 text-center">
      <p class="text-xs text-muted-foreground">{{ code ? "Enter this code on" : "Continue signing in on" }}</p>
      <p
        class="mt-1 inline-flex max-w-full items-center gap-1.5 text-base font-semibold text-foreground"
        data-testid="login-domain"
      >
        <Globe class="h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="truncate">{{ state.domain ?? url }}</span>
      </p>
      <div v-if="code" class="mt-5 flex items-center gap-1 pl-8">
        <code
          class="select-all font-mono text-[1.75rem] font-semibold leading-none tracking-[0.2em] text-foreground"
          data-testid="login-code"
          >{{ code }}</code
        >
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          :title="copied ? 'Copied' : 'Copy code'"
          :aria-label="copied ? 'Copied' : 'Copy code'"
          @click="copyCode"
        >
          <Check v-if="copied" class="h-4 w-4 text-success" />
          <Copy v-else class="h-4 w-4" />
        </Button>
      </div>
      <Button class="mt-6 min-w-[10rem]" :disabled="!url" @click="openBrowser">
        <ExternalLink class="h-4 w-4" />
        Open browser
      </Button>
      <p v-if="waiting" class="mt-4 flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
        <Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin" />
        Waiting for you to finish in the browser…
      </p>
    </div>

    <!-- Starting / a tool working -->
    <div
      v-else-if="waiting"
      class="flex items-center justify-center gap-2 rounded-xl bg-muted/50 px-6 py-10 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Loader2 class="h-4 w-4 shrink-0 animate-spin" />
      <span v-if="state.phase === 'waiting' && tool">Waiting for {{ tool }}…</span>
      <span v-else>Starting sign-in…</span>
    </div>

    <!-- Output -->
    <div v-if="outputCount > 0" class="grid gap-1.5">
      <button
        type="button"
        class="inline-flex w-fit items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground focus-ring"
        :aria-expanded="showOutput"
        @click="showOutput = !showOutput"
      >
        <ChevronRight class="h-3.5 w-3.5 transition-transform duration-fast" :class="showOutput ? 'rotate-90' : ''" />
        {{ showOutput ? "Hide" : "Show" }} output ({{ outputCount }} {{ outputCount === 1 ? "line" : "lines" }})
      </button>
      <pre
        v-if="showOutput"
        class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 font-mono text-2xs leading-4 text-muted-foreground"
        data-testid="login-output"
      ><template v-if="state.droppedLines">… {{ state.droppedLines }} earlier lines
</template><template v-for="(line, index) in state.lines" :key="index">{{ line.text }}
</template></pre>
    </div>
  </div>
</template>
