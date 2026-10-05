<script setup lang="ts">
/**
 * Signs in to a cloud account again (Accounts tab): IAM Identity Center
 * with a device code, or an MFA code for profiles that assume a role with
 * MFA. Starts right away: the user asked for it. Clusters using the account
 * reconnect by themselves.
 */
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert } from "lucide-vue-next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import LoginSessionPanel from "@/components/auth/LoginSessionPanel.vue";
import MfaCode from "@/views/clusters/add/MfaCode.vue";
import { useLoginSession } from "@/lib/auth/useLoginSession";
import { errorMessage, withVault } from "@/lib/clusters/managed";
import { awsMfaSignIn, awsProfiles, awsSsoSignIn, type CloudConnection } from "@/lib/clusters/cloud";
import { loadCloud } from "@/lib/clusters/catalogStore";

const props = defineProps<{ connection: CloudConnection }>();
const emit = defineEmits<{ close: [] }>();

let closeTimer: ReturnType<typeof setTimeout> | undefined;
const { state, begin, cancel, openUrl } = useLoginSession(
  {
    start: (channel) => withVault(() => awsSsoSignIn(props.connection.id, channel)),
    cancel: (sessionId) => invoke("auth_login_cancel", { sessionId }),
    openUrl: (sessionId, url) => invoke("auth_login_open_url", { sessionId, url }),
  },
  (finished) => {
    if (finished.phase !== "succeeded") return;
    void loadCloud();
    closeTimer = setTimeout(() => emit("close"), 1200);
  }
);
onBeforeUnmount(() => clearTimeout(closeTimer));

/* Profiles that assume a role with MFA take a code instead of a device sign-in. */
const mode = ref<"loading" | "device" | "mfa">("loading");
onMounted(async () => {
  if (props.connection.kind === "profile") {
    const profile = (await awsProfiles().catch(() => [])).find((p) => p.name === props.connection.profile);
    if (profile?.mfa) {
      mode.value = "mfa";
      return;
    }
  }
  mode.value = "device";
  begin();
});

const busy = ref(false);
const error = ref<string | null>(null);
const enterMfa = async (code: string) => {
  busy.value = true;
  error.value = null;
  try {
    await awsMfaSignIn(props.connection.id, code);
    await loadCloud();
    emit("close");
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
};

const close = () => {
  if (mode.value === "device") void cancel();
  emit("close");
};
</script>

<template>
  <Dialog :open="true" @update:open="(value: boolean) => !value && close()">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>Sign in to {{ connection.label }}</DialogTitle>
        <DialogDescription>
          <span class="font-mono">{{ connection.sso?.startUrl ?? connection.profile }}</span>
        </DialogDescription>
      </DialogHeader>
      <MfaCode v-if="mode === 'mfa'" :profile="connection.profile ?? ''" :busy="busy" @submit="enterMfa" />
      <LoginSessionPanel
        v-else-if="mode === 'device'"
        :state="state"
        success-detail="clusters reconnect by themselves"
        @open-url="openUrl"
        @cancel="cancel"
        @retry="begin"
        @close="close"
      />
      <p
        v-if="error"
        class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        role="alert"
      >
        <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" /> {{ error }}
      </p>
    </DialogContent>
  </Dialog>
</template>
