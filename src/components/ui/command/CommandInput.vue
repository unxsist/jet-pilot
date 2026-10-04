<script setup lang="ts">
import { MagnifyingGlassIcon } from "@radix-icons/vue";
import { ComboboxInput, type ComboboxInputProps } from "radix-vue";
import { cn } from "@/lib/utils";

const props = defineProps<ComboboxInputProps>();

const refocus = (e: FocusEvent) => {
  e.preventDefault();
  e.stopPropagation();
  (e.target as HTMLElement).focus();
};
</script>

<script lang="ts">
export default {
  inheritAttrs: false,
};
</script>

<template>
  <div class="flex items-center gap-2.5 border-b px-4" cmdk-input-wrapper>
    <MagnifyingGlassIcon class="h-4 w-4 shrink-0 text-muted-foreground" />
    <ComboboxInput
      v-bind="{ ...props, ...$attrs }"
      auto-focus
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      @focusout="refocus"
      :class="
        cn(
          'flex h-12 w-full bg-transparent py-3 text-[0.9375rem] text-foreground outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed disabled:opacity-50',
          $attrs.class ?? ''
        )
      "
    />
  </div>
</template>
