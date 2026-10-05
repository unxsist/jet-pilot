<script setup lang="ts">
/**
 * Signs in to a cloud account again (Accounts tab): IAM Identity Center
 * with a device code, or an MFA code for profiles that assume a role with
 * MFA. Starts right away: the user asked for it. Clusters using the account
 * reconnect by themselves.
 */
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, Loader2 } from "lucide-vue-next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import ProviderMark from "@/components/clusters/ProviderMark.vue";
import LoginSessionPanel from "@/components/auth/LoginSessionPanel.vue";
import MfaCode from "@/views/clusters/add/MfaCode.vue";
import WizardHeader from "@/components/wizard/WizardHeader.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_DIALOG, WIZARD_ERROR } from "@/components/wizard/wizard";
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

const code = ref("");
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

const finished = computed(() => state.value.phase === "failed" || state.value.phase === "cancelled");
const where = computed(() => props.connection.sso?.startUrl?.replace(/^https?:\/\//, "") ?? props.connection.profile ?? "");

const close = () => {
  if (mode.value === "device") void cancel();
  emit("close");
};
</script>

<template>
  <Dialog :open="true" @update:open="(value: boolean) => !value && close()">
    <DialogContent :class="[WIZARD_DIALOG, 'max-w-[30rem]']">
      <WizardHeader :title="`Sign in to ${connection.label}`">
        <template #icon><ProviderMark :provider="connection.provider" :size="22" /></template>
        <template #description>
          <span class="font-mono text-xs">{{ where }}</span>
        </template>
      </WizardHeader>

      <div :class="WIZARD_BODY">
        <MfaCode v-if="mode === 'mfa'" v-model="code" :profile="connection.profile ?? ''" @submit="enterMfa" />
        <LoginSessionPanel
          v-else-if="mode === 'device'"
          :state="state"
          success-detail="Clusters reconnect by themselves."
          @open-url="openUrl"
        />
        <p v-if="error" :class="[WIZARD_ERROR, 'mt-4']" role="alert">
          <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" /> {{ error }}
        </p>
      </div>

      <WizardFooter>
        <template v-if="mode === 'mfa'">
          <Button variant="ghost" @click="close">Cancel</Button>
          <Button :disabled="code.length !== 6 || busy" @click="enterMfa(code)">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Continue
          </Button>
        </template>
        <template v-else-if="finished">
          <Button variant="ghost" @click="close">Close</Button>
          <Button @click="begin">Retry</Button>
        </template>
        <Button v-else-if="state.phase === 'succeeded'" variant="outline" @click="emit('close')">Done</Button>
        <Button v-else variant="ghost" @click="close">Cancel</Button>
      </WizardFooter>
    </DialogContent>
  </Dialog>
</template>
