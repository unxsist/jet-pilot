<script lang="ts">
/* One clock for every badge: expiries count down while any is shown. */
const now = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function useNow() {
  onMounted(() => {
    now.value = Date.now();
    if (users++ === 0) timer = setInterval(() => (now.value = Date.now()), 30_000);
  });
  onUnmounted(() => {
    if (--users === 0) clearInterval(timer);
  });
  return now;
}
</script>

<script setup lang="ts">
/**
 * Compact credential status of a cluster: "Signed in", "Expires in 12m" (a
 * warning under 15 minutes), "Sign-in needed", "Expired". Quiet text with a
 * dot, not a chip; needing a sign-in makes it a small "Sign in" button that
 * opens the dialog.
 */
import { KeyRound, Loader2 } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { requestSignIn, useCredential } from "@/lib/auth/center";
import { credentialBadge } from "@/lib/auth/badge";

const props = withDefaults(
  defineProps<{ context: string; kubeConfig?: string; size?: "sm" | "default" }>(),
  { kubeConfig: "", size: "default" }
);

const view = useCredential(
  () => props.context,
  () => props.kubeConfig
);
const clock = useNow();
const badge = computed(() => credentialBadge(view.value, clock.value));

const TEXT: Record<string, string> = {
  success: "text-muted-foreground",
  muted: "text-muted-foreground",
  info: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};
const DOT: Record<string, string> = {
  success: "bg-success",
  muted: "bg-muted-foreground/50",
  warning: "bg-warning",
  destructive: "bg-destructive",
};
const HOVER: Record<string, string> = {
  warning: "hover:bg-warning/10",
  destructive: "hover:bg-destructive/10",
};
const classes = computed(() =>
  cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap", props.size === "sm" ? "text-xs" : "text-sm", badge.value && TEXT[badge.value.tone])
);

/* As in the hub's rows: "Sign in again" when expired, "Sign in" when needed, else the expiry. */
const label = computed(() =>
  !badge.value ? "" : badge.value.tone === "destructive" ? "Sign in again" : badge.value.text === "Sign-in needed" ? "Sign in" : badge.value.text
);

const signIn = () => void requestSignIn(view.value.target);
</script>

<template>
  <button
    v-if="badge?.signIn"
    type="button"
    :class="cn(classes, HOVER[badge.tone], '-mx-1.5 rounded-md px-1.5 py-0.5 font-medium transition-colors duration-fast focus-ring')"
    :title="badge.title"
    data-testid="credential-badge"
    @click.stop="signIn"
  >
    <KeyRound class="h-3.5 w-3.5" />
    {{ label }}
  </button>
  <span v-else-if="badge" :class="classes" :title="badge.title" data-testid="credential-badge">
    <Loader2 v-if="badge.tone === 'info'" class="h-3 w-3 animate-spin" />
    <span v-else class="h-1.5 w-1.5 rounded-full" :class="DOT[badge.tone]" />
    {{ badge.text }}
  </span>
</template>
