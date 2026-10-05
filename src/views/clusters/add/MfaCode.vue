<script setup lang="ts">
/**
 * A code from an MFA device, for profiles that assume a role with MFA
 * (`mfa_serial` in ~/.aws/config). Submits by itself at six digits; the
 * dialog's footer has the Continue button (v-model holds the digits).
 */
import { Smartphone } from "lucide-vue-next";
import { Input } from "@/components/ui/input";

defineProps<{ profile: string }>();
const emit = defineEmits<{ submit: [code: string] }>();
const code = defineModel<string>({ default: "" });
const input = ref<InstanceType<typeof Input> | null>(null);

watch(code, (value) => {
  const digits = value.replace(/\D/g, "").slice(0, 6);
  if (digits !== value) code.value = digits;
  else if (digits.length === 6) emit("submit", digits);
});
onMounted(() => nextTick(() => (input.value?.$el as HTMLInputElement | undefined)?.focus()));
</script>

<template>
  <form
    class="flex flex-col items-center gap-5 rounded-xl bg-muted/50 px-6 py-7 text-center"
    @submit.prevent="code.length === 6 && emit('submit', code)"
  >
    <span class="flex items-center gap-2 text-xs text-muted-foreground" :title="`For the ${profile} profile`">
      <Smartphone class="h-3.5 w-3.5" /> The 6-digit code from your MFA device
    </span>
    <Input
      ref="input"
      v-model="code"
      inputmode="numeric"
      autocomplete="one-time-code"
      aria-label="MFA code"
      placeholder="000000"
      class="h-12 w-52 bg-background text-center font-mono text-2xl font-semibold tracking-[0.35em] placeholder:font-normal placeholder:text-muted-foreground/50"
    />
    <span class="text-xs text-muted-foreground">JET Pilot keeps the session until it expires.</span>
  </form>
</template>
