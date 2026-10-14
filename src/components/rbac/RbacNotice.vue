<script setup lang="ts">
/**
 * What's missing when RBAC objects can't be listed, and what still works.
 * Nothing at all: a calm explanation in place of the answer. Some kinds:
 * a quiet line above it (answers may be incomplete).
 */
import { CircleAlert, Lock } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { joinWords } from "@/lib/rbac";
import type { RbacUnavailable } from "@/lib/accessReview";

const props = defineProps<{ unavailable: RbacUnavailable[] }>();
const emit = defineEmits<{ askMe: []; retry: [] }>();

const PLURAL: Record<string, string> = {
  ClusterRole: "ClusterRoles",
  ClusterRoleBinding: "ClusterRoleBindings",
  Role: "Roles",
  RoleBinding: "RoleBindings",
};

const all = computed(() => props.unavailable.length >= 4);
const forbidden = computed(() => props.unavailable.every((u) => u.forbidden));
const kinds = computed(() => joinWords(props.unavailable.map((u) => PLURAL[u.kind])));
const firstError = computed(() => props.unavailable.find((u) => !u.forbidden)?.message);
</script>

<template>
  <div
    v-if="all"
    class="flex flex-col items-center gap-3 rounded-xl border border-dashed px-8 py-12 text-center"
    role="status"
  >
    <span class="flex h-10 w-10 items-center justify-center rounded-lg border bg-surface-2 text-muted-foreground shadow-xs">
      <Lock class="h-5 w-5" />
    </span>
    <div class="max-w-md space-y-1.5">
      <p class="text-base font-medium">{{ forbidden ? "You can't read this cluster's RBAC" : "Couldn't load roles and bindings" }}</p>
      <p v-if="forbidden" class="text-sm text-muted-foreground">
        Answering this means reading every Role, ClusterRole and binding, and your account isn't allowed to list
        them. Can I still works: the cluster answers that one for you.
      </p>
      <p v-else class="break-words text-sm text-muted-foreground">{{ firstError }}</p>
    </div>
    <div class="flex items-center gap-2 pt-1">
      <Button variant="outline" @click="emit('askMe')">Ask Can I…</Button>
      <Button v-if="!forbidden" variant="ghost" @click="emit('retry')">Try again</Button>
    </div>
    <p v-if="forbidden" class="max-w-md pt-2 text-xs text-muted-foreground/80">
      To see it, an admin can grant you get, list and watch on roles, clusterroles, rolebindings and
      clusterrolebindings (rbac.authorization.k8s.io).
    </p>
  </div>

  <div v-else class="flex items-start gap-2.5 rounded-lg bg-muted/60 px-3.5 py-2.5 text-xs text-muted-foreground" role="status">
    <CircleAlert class="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
    <span>
      <template v-if="forbidden">
        You can't list {{ kinds }}, so answers may be missing people and permissions they grant.
      </template>
      <template v-else>Couldn't load {{ kinds }}: {{ firstError }}</template>
    </span>
  </div>
</template>
