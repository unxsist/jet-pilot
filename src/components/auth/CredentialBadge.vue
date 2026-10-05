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
 * Compact credential status of a cluster for lists: "Signed in",
 * "Expires in 12m" (a warning under 15 minutes), "Sign-in needed",
 * "Expired". Needing a sign-in makes it a button that opens the dialog.
 */
import { badgeVariants } from "@/components/ui/badge";
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
const classes = computed(() =>
  badge.value ? badgeVariants({ variant: badge.value.tone, size: props.size }) : ""
);

/* Clickable badges: a stronger border on hover (the tint stays AA). */
const HOVER: Record<string, string> = {
  warning: "hover:border-warning/50",
  destructive: "hover:border-destructive/50",
};

const signIn = () => void requestSignIn(view.value.target);
</script>

<template>
  <button
    v-if="badge?.signIn"
    type="button"
    :class="cn(classes, HOVER[badge.tone], 'cursor-pointer focus-ring')"
    :title="badge.title"
    data-testid="credential-badge"
    @click.stop="signIn"
  >
    {{ badge.text }}
  </button>
  <span v-else-if="badge" :class="classes" :title="badge.title" data-testid="credential-badge">
    {{ badge.text }}
  </span>
</template>
