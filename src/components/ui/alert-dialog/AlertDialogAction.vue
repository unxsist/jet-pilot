<script setup lang="ts">
/*
 * Closes the dialog before the @click handler runs (radix's close handler
 * comes first), so the handler must not depend on state cleared when the
 * dialog closes: keep the target apart from the open state.
 */
import { AlertDialogAction, type AlertDialogActionProps } from 'radix-vue'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

const props = defineProps<AlertDialogActionProps>()
</script>

<template>
  <AlertDialogAction v-bind="props" :class="cn(buttonVariants(), $attrs.class ?? '')">
    <slot />
  </AlertDialogAction>
</template>
