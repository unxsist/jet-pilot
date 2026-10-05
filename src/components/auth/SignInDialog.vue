<script setup lang="ts">
/**
 * Signs in to a cluster (requestSignIn(), rendered by AuthHost). The login
 * starts right away: the user asked for it. On success the backend fans the
 * new credential out to every cluster using it (`auth://resolved`), views
 * reconnect, and the dialog closes by itself.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ClusterLabel from "@/components/clusters/ClusterLabel.vue";
import LoginSessionPanel from "./LoginSessionPanel.vue";
import {
  credentialView,
  keyOf,
  onRecoveredBatch,
  recover,
  setSigningIn,
  type SignInRequest,
} from "@/lib/auth/center";
import { useLoginSession } from "@/lib/auth/useLoginSession";

const props = defineProps<{ request: SignInRequest }>();
const emit = defineEmits<{ (e: "close", signedIn: boolean): void }>();

const target = props.request.target;
const view = computed(() => credentialView(target));

const basename = (command: string) => command.split(/[\\/]/).pop() || command;

const methodLine = computed(() => {
  const status = view.value.status;
  if (status?.signInLabel) return status.signInLabel;
  if (status?.command) return `Signs in with ${basename(status.command)}.`;
  return "Signs in with the method set in its kubeconfig.";
});

const STATE_TEXT: Partial<Record<string, string>> = {
  expired: "Expired",
  needsLogin: "Sign-in needed",
  expiringSoon: "Expires soon",
};

/* Clusters the sign-in reconnected (the backend's fan-out). */
const reconnecting = ref<number | null>(null);
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const { state, begin, cancel, openUrl } = useLoginSession(
  {
    start: (onEvent) => invoke<string>("auth_login_start", { target, onEvent }),
    cancel: (sessionId) => invoke("auth_login_cancel", { sessionId }),
    openUrl: (sessionId, url) => invoke("auth_login_open_url", { sessionId, url }),
  },
  (finished) => {
    setSigningIn(target, false);
    if (finished.phase !== "succeeded") return;
    // Without a fan-out from the backend, at least this cluster recovers.
    fallbackTimer = setTimeout(() => {
      if (reconnecting.value === null) recover([target]);
    }, 1500);
    closeTimer = setTimeout(() => emit("close", true), 2400);
  }
);

const stopListening = onRecoveredBatch((targets) => {
  if (targets.some((t) => keyOf(t) === keyOf(target))) {
    reconnecting.value = targets.length;
  }
});

const successDetail = computed(() =>
  reconnecting.value === null
    ? "reconnecting…"
    : `reconnecting ${reconnecting.value} ${reconnecting.value === 1 ? "cluster" : "clusters"}`
);

const start = () => {
  reconnecting.value = null;
  setSigningIn(target, true);
  begin();
};
onMounted(start);

const openBrowser = (url: string) => {
  openUrl(url).catch((e) => console.warn(`[auth] could not open ${url}: ${e}`));
};

const cancelAndClose = () => {
  void cancel();
  emit("close", false);
};

/* Escape, the close button or the backdrop. */
const dismiss = () => {
  if (state.value.phase === "succeeded") emit("close", true);
  else cancelAndClose();
};

onUnmounted(() => {
  stopListening();
  clearTimeout(fallbackTimer);
  clearTimeout(closeTimer);
  setSigningIn(target, false);
});
</script>

<template>
  <Dialog :open="true" @update:open="(open: boolean) => !open && dismiss()">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>Sign in</DialogTitle>
        <DialogDescription>{{ methodLine }}</DialogDescription>
      </DialogHeader>

      <div class="flex min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2">
        <ClusterLabel
          :context="target.context"
          :kube-config="target.kubeConfig"
          size="default"
          class="font-medium"
        />
        <span
          v-if="state.phase !== 'succeeded' && STATE_TEXT[view.state]"
          class="ml-auto shrink-0 text-xs font-medium"
          :class="view.state === 'expired' ? 'text-destructive' : 'text-warning'"
        >
          {{ STATE_TEXT[view.state] }}
        </span>
      </div>

      <LoginSessionPanel
        :state="state"
        :success-detail="successDetail"
        @open-url="openBrowser"
        @cancel="cancelAndClose"
        @retry="start"
        @close="emit('close', false)"
      />
    </DialogContent>
  </Dialog>
</template>
