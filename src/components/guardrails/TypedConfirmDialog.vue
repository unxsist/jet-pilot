<script setup lang="ts">
/**
 * Typed confirmation for risky actions on protected clusters: what happens
 * and where (the cluster, by its avatar and name), the targets when there
 * are several, and the exact name (or a count like "3 pods") to type before
 * the action runs.
 */
import { CheckCircle2, ShieldAlert } from "lucide-vue-next";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ClusterLabel from "@/components/clusters/ClusterLabel.vue";
import { phraseMatches } from "@/lib/guardrails/policy";
import type { TypedConfirmRequest } from "@/lib/guardrails/guard";

const props = defineProps<{ request: TypedConfirmRequest }>();
const emit = defineEmits<{ (e: "settle", confirmed: boolean): void }>();

const typed = ref("");
const matches = computed(() => phraseMatches(typed.value, props.request.phrase));
const inputId = computed(() => `typed-confirm-${props.request.id}`);
const protectedCount = computed(() => props.request.clusters.filter((cluster) => cluster.protected).length);

const submit = () => {
  if (matches.value) emit("settle", true);
};
</script>

<template>
  <AlertDialog
    :open="true"
    @update:open="(open: boolean) => !open && emit('settle', false)"
  >
    <AlertDialogContent class="max-w-md gap-0 p-0">
      <form data-testid="typed-confirm" @submit.prevent="submit">
        <div class="space-y-5 p-6">
          <div class="flex gap-4">
            <span
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
              aria-hidden="true"
            >
              <ShieldAlert class="h-5 w-5" />
            </span>
            <AlertDialogHeader class="min-w-0 gap-1">
              <AlertDialogTitle class="break-words">{{ request.title }}</AlertDialogTitle>
              <AlertDialogDescription>
                <template v-if="request.clusters.length > 1">
                  This runs on {{ request.clusters.length }} clusters,
                  {{ protectedCount === request.clusters.length ? "all" : protectedCount }} of them protected.
                </template>
                <template v-else>This runs on a protected cluster.</template>
              </AlertDialogDescription>
            </AlertDialogHeader>
          </div>

          <div class="divide-y divide-border-subtle rounded-lg border bg-muted/40">
            <ul aria-label="Clusters">
              <li
                v-for="cluster in request.clusters"
                :key="cluster.key"
                class="flex min-w-0 items-center gap-3 px-3 py-2.5"
              >
                <ClusterLabel
                  :context="cluster.context"
                  :kube-config="cluster.kubeConfig"
                  size="default"
                  class="text-sm font-medium"
                />
                <!-- One cluster: the sentence says it's protected; show which context it is. -->
                <span v-if="request.clusters.length > 1" class="ml-auto shrink-0 text-xs text-destructive">
                  {{ cluster.protected ? "Protected" : "" }}
                </span>
                <span
                  v-else-if="cluster.context !== cluster.displayName"
                  class="ml-auto min-w-0 truncate text-xs text-muted-foreground"
                  :title="cluster.context"
                >
                  {{ cluster.context }}
                </span>
              </li>
            </ul>
            <!-- One target: the title names it. -->
            <ul
              v-if="request.targets.length > 1"
              class="max-h-40 space-y-1 overflow-auto px-3 py-2.5 font-mono text-xs text-muted-foreground"
              aria-label="Targets"
            >
              <li v-for="(line, index) in request.targets" :key="index" class="truncate" :title="line">
                {{ line }}
              </li>
            </ul>
          </div>

          <p v-if="request.requireDryRun" class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 class="h-3.5 w-3.5 text-success" /> The server-side dry run passed.
          </p>

          <div class="space-y-2">
            <label :for="inputId" class="block text-sm text-muted-foreground">
              Type
              <span class="select-all break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">{{
                request.phrase
              }}</span>
              to confirm.
            </label>
            <Input
              :id="inputId"
              v-model="typed"
              class="font-mono text-xs"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              data-testid="typed-confirm-input"
            />
          </div>
        </div>

        <AlertDialogFooter class="mt-0 border-t px-6 py-4">
          <Button type="button" variant="ghost" @click="emit('settle', false)">
            Cancel
          </Button>
          <Button
            type="submit"
            :variant="request.destructive ? 'destructive' : 'default'"
            :disabled="!matches"
          >
            {{ request.verb }}
          </Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  </AlertDialog>
</template>
