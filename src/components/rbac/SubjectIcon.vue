<script setup lang="ts">
/** The round mark of a subject: a person, a group, or a service account. */
import { User, UserCog, Users } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import type { SubjectKind } from "@/lib/rbac";

const props = withDefaults(defineProps<{ kind: SubjectKind; size?: "sm" | "md" | "lg"; class?: string }>(), {
  size: "md",
  class: undefined,
});
const ICONS = { User, Group: Users, ServiceAccount: UserCog };
const SIZES = {
  sm: { mark: "h-6 w-6", icon: "h-3 w-3" },
  md: { mark: "h-8 w-8", icon: "h-3.5 w-3.5" },
  lg: { mark: "h-10 w-10", icon: "h-4 w-4" },
};
</script>

<template>
  <span
    :class="
      cn(
        'flex shrink-0 items-center justify-center rounded-full border border-border-subtle bg-surface-2 text-muted-foreground',
        SIZES[size].mark,
        props.class
      )
    "
    aria-hidden="true"
  >
    <component :is="ICONS[kind]" :class="SIZES[size].icon" :stroke-width="1.75" />
  </span>
</template>
