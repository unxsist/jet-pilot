<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/*
 * Toolbar button with a tooltip (label + optional shortcut). `pressed`
 * makes it a toggle (aria-pressed, accent icon). Needs a TooltipProvider
 * ancestor.
 */
const props = withDefaults(
  defineProps<{
    label: string;
    shortcut?: string[];
    pressed?: boolean;
    disabled?: boolean;
    /* Show the label next to the icon. */
    text?: boolean;
    variant?: "ghost" | "outline";
    class?: HTMLAttributes["class"];
  }>(),
  { pressed: undefined, variant: "ghost", text: false }
);

const emit = defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <Tooltip :delay-duration="300">
    <TooltipTrigger as-child>
      <Button
        :variant="props.variant"
        :size="props.text ? 'sm' : 'icon-sm'"
        :aria-label="props.label"
        :aria-pressed="props.pressed"
        :disabled="props.disabled"
        :class="
          cn(
            props.pressed === true
              ? 'bg-primary/10 text-link hover:bg-primary/15 hover:text-link'
              : props.variant === 'ghost'
                ? 'text-muted-foreground hover:text-foreground'
                : '',
            props.class
          )
        "
        @click="emit('click', $event)"
      >
        <slot />
      </Button>
    </TooltipTrigger>
    <TooltipContent class="flex items-center gap-2">
      {{ props.label }}
      <Kbd
        v-if="props.shortcut"
        :keys="props.shortcut"
        variant="ghost"
        size="sm"
      />
    </TooltipContent>
  </Tooltip>
</template>
