<script setup lang="ts">
/**
 * The vault passphrase: set one up (no system keychain on this computer) or
 * unlock the vault for this session. Opened by withVault() when storing or
 * reading cluster credentials needs it.
 */
import { type as getOsType } from "@tauri-apps/plugin-os";
import { CircleAlert, KeyRound, Loader2 } from "lucide-vue-next";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import WizardHeader from "@/components/wizard/WizardHeader.vue";
import WizardFooter from "@/components/wizard/WizardFooter.vue";
import { WIZARD_BODY, WIZARD_DIALOG, WIZARD_ERROR } from "@/components/wizard/wizard";
import { errorMessage, initPassphrase, unlockVault, type VaultPrompt } from "@/lib/clusters/managed";

const props = defineProps<{ prompt: VaultPrompt }>();
const emit = defineEmits<{ done: [ok: boolean] }>();

const linux = getOsType() === "linux";
const passphrase = ref("");
const repeat = ref("");
const cacheForTerminals = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);

const setup = computed(() => props.prompt.mode === "setup");
const valid = computed(() =>
  setup.value ? passphrase.value.length >= 8 && passphrase.value === repeat.value : passphrase.value.length > 0
);
/* Only once both are typed: a mismatch while typing the second isn't news. */
const mismatch = computed(() => setup.value && repeat.value.length >= passphrase.value.length && repeat.value !== passphrase.value && !!repeat.value);

const submit = async () => {
  if (!valid.value || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    if (setup.value) await initPassphrase(passphrase.value);
    else await unlockVault(passphrase.value, linux && cacheForTerminals.value);
    emit("done", true);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <Dialog :open="true" @update:open="(value: boolean) => !value && emit('done', false)">
    <DialogContent :class="[WIZARD_DIALOG, 'max-w-[30rem]']">
      <WizardHeader
        :title="setup ? 'Protect your cluster credentials' : 'Unlock your cluster credentials'"
        :description="
          setup
            ? 'No system keychain here, so JET Pilot encrypts them with a passphrase you enter once per session.'
            : 'Enter your vault passphrase to use them this session.'
        "
      >
        <template #icon><KeyRound class="h-[18px] w-[18px]" /></template>
      </WizardHeader>

      <form id="vault-passphrase" :class="[WIZARD_BODY, 'space-y-3']" @submit.prevent="submit">
        <Input
          v-model="passphrase"
          type="password"
          :placeholder="setup ? 'Passphrase, at least 8 characters' : 'Passphrase'"
          autofocus
          autocomplete="off"
          aria-label="Passphrase"
        />
        <template v-if="setup">
          <Input
            v-model="repeat"
            type="password"
            placeholder="Repeat the passphrase"
            autocomplete="off"
            aria-label="Repeat the passphrase"
            :aria-invalid="mismatch"
          />
          <p v-if="mismatch" class="text-xs text-destructive">The passphrases don't match.</p>
        </template>
        <label v-if="linux && !setup" class="flex w-fit cursor-pointer items-center gap-2 pt-1 text-sm text-muted-foreground">
          <Checkbox v-model:checked="cacheForTerminals" />
          Also unlock kubectl in your terminals for 12 hours
        </label>
        <p v-if="setup && prompt.problem" class="pt-1 text-xs text-muted-foreground">
          {{ prompt.problem }} With a keychain set up, no passphrase is needed.
        </p>
        <p v-if="error" :class="WIZARD_ERROR" role="alert">
          <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0" /> {{ error }}
        </p>
      </form>

      <WizardFooter>
        <Button type="button" variant="ghost" @click="emit('done', false)">Cancel</Button>
        <Button type="submit" form="vault-passphrase" :disabled="!valid || busy">
          <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
          {{ setup ? "Set passphrase" : "Unlock" }}
        </Button>
      </WizardFooter>
    </DialogContent>
  </Dialog>
</template>
