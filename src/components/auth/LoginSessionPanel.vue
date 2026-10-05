<script setup lang="ts">
/**
 * A login in progress (lib/auth/loginSession.ts): the device code to enter
 * with the domain it belongs to (shown prominently: only enter codes on a
 * page you expect), Open browser, a waiting state, the redacted output and
 * the outcome. Presentational: the owner runs the session.
 */
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  TriangleAlert,
} from "lucide-vue-next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/button";
import { browserUrl, type LoginViewState } from "@/lib/auth/loginSession";

const props = defineProps<{
  state: LoginViewState;
  /** After "Signed in · ", e.g. "reconnecting 3 clusters". */
  successDetail?: string;
}>();

const emit = defineEmits<{
  (e: "open-url", url: string): void;
  (e: "cancel"): void;
  (e: "retry"): void;
  (e: "close"): void;
}>();

const url = computed(() => browserUrl(props.state));
const code = computed(() => props.state.deviceCode?.userCode ?? null);
const waiting = computed(
  () => props.state.phase === "starting" || props.state.phase === "waiting"
);
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
  <div class="grid gap-4" data-testid="login-session">
    <!-- Signed in -->
    <div
      v-if="state.phase === 'succeeded'"
      class="flex items-center gap-3 rounded-lg border border-success/25 bg-success/[0.06] px-3.5 py-3"
      role="status"
    >
      <CheckCircle2 class="h-5 w-5 shrink-0 text-success" />
      <p class="min-w-0 text-sm font-medium text-foreground">
        Signed in<span v-if="successDetail" class="font-normal text-muted-foreground">
          · {{ successDetail }}</span
        >
      </p>
    </div>

    <!-- Failed / cancelled -->
    <div
      v-else-if="state.phase === 'failed' || state.phase === 'cancelled'"
      class="flex gap-3 rounded-lg border px-3.5 py-3"
      :class="state.phase === 'failed' ? 'border-destructive/25 bg-destructive/[0.06]' : 'bg-card'"
      role="alert"
    >
      <TriangleAlert
        class="mt-0.5 h-4 w-4 shrink-0"
        :class="state.phase === 'failed' ? 'text-destructive' : 'text-muted-foreground'"
      />
      <div class="min-w-0">
        <p class="text-sm font-medium text-foreground">
          {{ state.phase === "failed" ? "Sign-in failed" : "Sign-in cancelled" }}
        </p>
        <p
          v-if="state.error"
          class="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-line break-words text-xs text-muted-foreground"
        >
          {{ state.error }}
        </p>
      </div>
    </div>

    <!-- Device code -->
    <div v-else-if="code" class="grid gap-3 rounded-lg border bg-card p-4 text-center">
      <div>
        <p class="text-xs text-muted-foreground">Enter this code on</p>
        <p
          class="mt-0.5 inline-flex max-w-full items-center gap-1.5 text-base font-semibold text-foreground"
          data-testid="login-domain"
        >
          <Globe class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ state.domain ?? url }}</span>
        </p>
      </div>
      <div class="flex items-center justify-center gap-2">
        <code
          class="select-all rounded-md border bg-muted px-3.5 py-1.5 font-mono text-2xl font-semibold tracking-[0.18em] text-foreground"
          data-testid="login-code"
          >{{ code }}</code
        >
        <Button
          variant="outline"
          size="icon"
          :title="copied ? 'Copied' : 'Copy code'"
          :aria-label="copied ? 'Copied' : 'Copy code'"
          @click="copyCode"
        >
          <Check v-if="copied" class="h-4 w-4 text-success" />
          <Copy v-else class="h-4 w-4" />
        </Button>
      </div>
      <Button class="justify-self-center" :disabled="!url" @click="openBrowser">
        <ExternalLink class="h-4 w-4" />
        Open browser
      </Button>
    </div>

    <!-- Browser sign-in -->
    <div v-else-if="url" class="grid gap-3 rounded-lg border bg-card p-4 text-center">
      <div>
        <p class="text-xs text-muted-foreground">Continue signing in on</p>
        <p
          class="mt-0.5 inline-flex max-w-full items-center gap-1.5 text-base font-semibold text-foreground"
          data-testid="login-domain"
        >
          <Globe class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ state.domain ?? url }}</span>
        </p>
      </div>
      <Button class="justify-self-center" @click="openBrowser">
        <ExternalLink class="h-4 w-4" />
        Open browser
      </Button>
    </div>

    <!-- Waiting -->
    <div
      v-if="waiting"
      class="flex items-center gap-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Loader2 class="h-4 w-4 shrink-0 animate-spin" />
      <span v-if="code || url">Waiting for you to finish signing in…</span>
      <span v-else-if="state.phase === 'waiting' && tool">Waiting for {{ tool }}…</span>
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
        <ChevronRight
          class="h-3.5 w-3.5 transition-transform duration-fast"
          :class="showOutput ? 'rotate-90' : ''"
        />
        {{ showOutput ? "Hide" : "Show" }} output ({{ outputCount }}
        {{ outputCount === 1 ? "line" : "lines" }})
      </button>
      <pre
        v-if="showOutput"
        class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 px-3 py-2 font-mono text-2xs leading-4 text-muted-foreground"
        data-testid="login-output"
      ><template v-if="state.droppedLines">… {{ state.droppedLines }} earlier lines
</template><template v-for="(line, index) in state.lines" :key="index">{{ line.text }}
</template></pre>
    </div>

    <div class="flex justify-end gap-2">
      <template v-if="state.phase === 'failed' || state.phase === 'cancelled'">
        <Button variant="ghost" @click="emit('close')">Close</Button>
        <Button @click="emit('retry')">Retry</Button>
      </template>
      <Button v-else-if="waiting" variant="ghost" @click="emit('cancel')">Cancel</Button>
    </div>
  </div>
</template>
