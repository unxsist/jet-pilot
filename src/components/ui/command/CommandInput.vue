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
  <div class="flex items-center border-b px-3" cmdk-input-wrapper>
    <MagnifyingGlassIcon class="mr-2 h-4 w-4 shrink-0 opacity-50" />
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
          'flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          $attrs.class ?? ''
        )
      "
    />
  </div>
</template>
