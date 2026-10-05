<script setup lang="ts">
/**
 * The header of a calm dialog (adding a cluster, signing in, export, edit):
 * an optional icon tile for context (a provider mark, the cluster's avatar,
 * an outcome), the title and one quiet line. The body scrolls between this
 * and a WizardFooter; see `wizard.ts` for the dialog's own classes.
 */
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

withDefaults(defineProps<{ title: string; description?: string; tone?: "default" | "success" | "bare" }>(), {
  description: undefined,
  tone: "default",
});
</script>

<template>
  <header class="flex shrink-0 items-start gap-3.5 px-6 pb-5 pr-12 pt-6">
    <span
      v-if="$slots.icon"
      :class="
        cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]',
          tone === 'success' && 'bg-success/10 text-success',
          tone === 'default' && 'bg-muted text-muted-foreground ring-1 ring-inset ring-border/60'
        )
      "
    >
      <slot name="icon" />
    </span>
    <div class="min-w-0 flex-1 space-y-1" :class="$slots.icon ? 'pt-px' : ''">
      <DialogTitle class="text-pretty">{{ title }}</DialogTitle>
      <DialogDescription class="text-pretty">
        <slot name="description">{{ description }}</slot>
      </DialogDescription>
    </div>
  </header>
</template>
