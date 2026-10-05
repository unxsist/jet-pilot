<script setup lang="ts">
/**
 * Signs in to a cluster (requestSignIn(), rendered by AuthHost). The login
 * starts right away: the user asked for it. On success the backend fans the
 * new credential out to every cluster using it (`auth://resolved`), views
 * reconnect, and the dialog closes by itself.
 */
import { invoke } from "@tauri-apps/api/core";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import ContextAvatar from "@/components/ContextAvatar.vue";
import LoginSessionPanel from "./LoginSessionPanel.vue";
import WizardHeader from "@/components/wizard/WizardHeader.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_DIALOG } from "@/components/wizard/wizard";
import { resolveCluster } from "@/lib/clusters/meta";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
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
const settingsState = inject(SettingsContextStateKey, null);
const name = computed(
  () => resolveCluster(settingsState?.settings.value.clusters, target.context, target.kubeConfig).displayName
);

const basename = (command: string) => command.split(/[\\/]/).pop() || command;

const methodLine = computed(() => {
  const status = view.value.status;
  if (status?.signInLabel) return status.signInLabel;
  if (status?.command) return `With ${basename(status.command)}`;
  return "With the method set in its kubeconfig";
});

/* Why it's asking, before how it signs in: "Expired · Microsoft Entra ID…". */
const STATE_TEXT: Partial<Record<string, string>> = {
  expired: "Expired",
  needsLogin: "Sign-in needed",
  expiringSoon: "Expires soon",
};
const finished = computed(() => state.value.phase === "failed" || state.value.phase === "cancelled");

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
    <DialogContent :class="[WIZARD_DIALOG, 'max-w-[30rem]']">
      <WizardHeader :title="`Sign in to ${name}`" tone="bare">
        <template #icon>
          <ContextAvatar :name="target.context" :kube-config="target.kubeConfig" size="lg" />
        </template>
        <template #description>
          <span
            v-if="state.phase !== 'succeeded' && STATE_TEXT[view.state]"
            :class="view.state === 'expired' ? 'text-destructive' : 'text-warning'"
            >{{ STATE_TEXT[view.state] }} ·
          </span>
          {{ methodLine }}
        </template>
      </WizardHeader>

      <div :class="WIZARD_BODY">
        <LoginSessionPanel :state="state" :success-detail="successDetail" @open-url="openBrowser" />
      </div>

      <WizardFooter>
        <template v-if="finished">
          <Button variant="ghost" @click="emit('close', false)">Close</Button>
          <Button @click="start">Retry</Button>
        </template>
        <Button v-else-if="state.phase === 'succeeded'" variant="outline" @click="emit('close', true)">Done</Button>
        <Button v-else variant="ghost" @click="cancelAndClose">Cancel</Button>
      </WizardFooter>
    </DialogContent>
  </Dialog>
</template>
