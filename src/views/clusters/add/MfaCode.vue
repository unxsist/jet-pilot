<script setup lang="ts">
/**
 * A code from an MFA device, for profiles that assume a role with MFA
 * (`mfa_serial` in ~/.aws/config). Submits by itself at six digits.
 */
import { Loader2, Smartphone } from "lucide-vue-next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

defineProps<{ profile: string; busy: boolean }>();
const emit = defineEmits<{ submit: [code: string] }>();
const code = ref("");
const input = ref<InstanceType<typeof Input> | null>(null);

watch(code, (value) => {
  const digits = value.replace(/\D/g, "").slice(0, 6);
  if (digits !== value) code.value = digits;
  else if (digits.length === 6) emit("submit", digits);
});
onMounted(() => nextTick(() => (input.value?.$el as HTMLInputElement | undefined)?.focus()));
</script>

<template>
  <form class="flex flex-col items-center gap-4 py-4 text-center" @submit.prevent="code.length === 6 && emit('submit', code)">
    <span class="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
      <Smartphone class="h-5 w-5" />
    </span>
    <div class="space-y-1">
      <p class="text-sm font-medium">Enter the code from your MFA device</p>
      <p class="text-xs text-muted-foreground">
        The profile <span class="font-mono">{{ profile }}</span> assumes a role that needs it. JET Pilot keeps the
        session until it expires.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <Input
        ref="input"
        v-model="code"
        inputmode="numeric"
        autocomplete="one-time-code"
        aria-label="MFA code"
        placeholder="000000"
        class="h-10 w-36 text-center font-mono text-lg tracking-[0.3em]"
      />
      <Button type="submit" :disabled="code.length !== 6 || busy">
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" /> Continue
      </Button>
    </div>
  </form>
</template>
