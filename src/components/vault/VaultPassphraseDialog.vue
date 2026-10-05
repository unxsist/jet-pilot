<script setup lang="ts">
/**
 * The vault passphrase: set one up (no system keychain on this computer) or
 * unlock the vault for this session. Opened by withVault() when storing or
 * reading cluster credentials needs it.
 */
import { type as getOsType } from "@tauri-apps/plugin-os";
import { KeyRound, Loader2 } from "lucide-vue-next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <KeyRound class="h-4 w-4 text-primary" />
          {{ setup ? "Protect your cluster credentials" : "Unlock your cluster credentials" }}
        </DialogTitle>
        <DialogDescription v-if="setup">
          There's no system keychain available, so JET Pilot encrypts the credentials of clusters you add with a
          passphrase. You'll enter it once per session.
        </DialogDescription>
        <DialogDescription v-else>JET Pilot needs your vault passphrase to use these credentials.</DialogDescription>
      </DialogHeader>

      <p v-if="setup && prompt.problem" class="rounded-md border bg-surface-1 px-3 py-2 text-xs text-muted-foreground">
        {{ prompt.problem }} With a keychain set up, no passphrase is needed.
      </p>

      <form class="space-y-3" @submit.prevent="submit">
        <Input v-model="passphrase" type="password" :placeholder="setup ? 'Passphrase (at least 8 characters)' : 'Passphrase'" autofocus autocomplete="off" aria-label="Passphrase" />
        <Input v-if="setup" v-model="repeat" type="password" placeholder="Repeat the passphrase" autocomplete="off" aria-label="Repeat the passphrase" />
        <label v-if="linux" class="flex items-start gap-2 text-xs text-muted-foreground">
          <Checkbox v-model:checked="cacheForTerminals" class="mt-0.5" />
          Also unlock for kubectl in your terminals for 12 hours
        </label>
        <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
        <DialogFooter>
          <Button type="button" variant="ghost" @click="emit('done', false)">Cancel</Button>
          <Button type="submit" :disabled="!valid || busy">
            <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
            {{ setup ? "Set passphrase" : "Unlock" }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
