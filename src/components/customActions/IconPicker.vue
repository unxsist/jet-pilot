<script setup lang="ts">
/* The action's icon: a tile that opens the curated icon set. */
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ACTION_ICON_NAMES, actionIconComponent } from "@/lib/customActions/icons";
import { cn } from "@/lib/utils";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const open = ref(false);

const pick = (name: string) => {
  emit("update:modelValue", name);
  open.value = false;
};
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-surface-1 text-foreground shadow-xs transition-colors duration-fast hover:bg-accent focus-ring"
        :aria-label="`Icon: ${props.modelValue}. Change`"
        title="Change the icon"
      >
        <component :is="actionIconComponent(props.modelValue)" class="h-4 w-4" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-auto p-2">
      <div class="grid grid-cols-7 gap-1" role="listbox" aria-label="Icons">
        <button
          v-for="name in ACTION_ICON_NAMES"
          :key="name"
          type="button"
          role="option"
          :aria-selected="name === props.modelValue"
          :title="name"
          :class="
            cn(
              'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground focus-ring',
              name === props.modelValue && 'bg-accent text-foreground'
            )
          "
          @click="pick(name)"
        >
          <component :is="actionIconComponent(name)" class="h-4 w-4" />
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>
