<script setup lang="ts">
/**
 * Why a subject may do something, as a small breadcrumb: (the group it
 * applies through ›) binding › role, and a quiet note (how a wildcard
 * matched). Binding and role open in the side panel.
 */
import { ChevronRight } from "lucide-vue-next";
import ObjectLink from "./ObjectLink.vue";
import { useRbacLinks } from "./useRbacLinks";
import type { BindingObject, RoleObject } from "@/lib/rbac";

withDefaults(
  defineProps<{
    binding: BindingObject;
    role: RoleObject | null;
    viaGroup?: string;
    note?: string | null;
    /** false: only the names are known (RBAC can't be listed); no links, no warnings. */
    readable?: boolean;
    size?: "xs" | "sm";
  }>(),
  { viaGroup: undefined, note: undefined, readable: true, size: "xs" }
);

const { openObject } = useRbacLinks();
</script>

<template>
  <span class="flex min-w-0 flex-wrap items-center gap-1.5" :class="size === 'sm' ? 'text-sm leading-6' : 'text-xs leading-5'">
    <template v-if="viaGroup">
      <span class="text-muted-foreground">through <span class="font-medium text-foreground">{{ viaGroup }}</span></span>
      <ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
    </template>
    <ObjectLink :kind="binding.kind" :name="binding.metadata.name" :object="readable ? binding : null" @open="openObject(binding)" />
    <ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
    <ObjectLink :kind="binding.roleRef.kind" :name="binding.roleRef.name" :object="role" :missing="readable && !role" @open="role && openObject(role)" />
    <span v-if="note" class="min-w-0 truncate text-muted-foreground" :title="note">· {{ note }}</span>
  </span>
</template>
