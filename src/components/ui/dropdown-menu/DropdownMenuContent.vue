<script setup lang="ts">
import {
  DropdownMenuContent,
  type DropdownMenuContentEmits,
  type DropdownMenuContentProps,
  DropdownMenuPortal,
  useForwardPropsEmits,
} from "radix-vue";
import { cn } from "@/lib/utils";
import { menuContent } from "@/components/ui/overlay-styles";

const props = withDefaults(
  defineProps<DropdownMenuContentProps & { class?: string }>(),
  {
    sideOffset: 4,
  }
);
const emits = defineEmits<DropdownMenuContentEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <DropdownMenuPortal>
    <DropdownMenuContent
      :class="[
        cn(
          menuContent,
          props.class
        ),
      ]"
      v-bind="forwarded"
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>
