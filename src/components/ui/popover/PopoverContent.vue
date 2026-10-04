<script setup lang="ts">
import {
  PopoverContent,
  type PopoverContentEmits,
  type PopoverContentProps,
  PopoverPortal,
  useForwardPropsEmits,
} from 'radix-vue'
import { cn } from '@/lib/utils'
import { floatingMotion, floatingSurface } from '@/components/ui/overlay-styles'

const props = withDefaults(
  defineProps<PopoverContentProps & { class?: string }>(),
  {
    sideOffset: 4,
  },
)
const emits = defineEmits<PopoverContentEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <PopoverPortal>
    <PopoverContent
      v-bind="{ ...forwarded, ...$attrs }"
      :class="
        cn(
          floatingSurface,
          floatingMotion,
          'w-72 p-3',
          props.class,
        )
      "
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>
