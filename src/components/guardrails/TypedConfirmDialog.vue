<script setup lang="ts">
/**
 * Typed confirmation for risky actions on protected clusters: the cluster
 * up front, the targets, and a field where the resource name (or a count
 * like "3 pods") has to be typed before the action runs.
 */
import { ShieldAlert } from "lucide-vue-next";
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
import { Label } from "@/components/ui/label";
import ClusterLabel from "@/components/clusters/ClusterLabel.vue";
import { phraseMatches } from "@/lib/guardrails/policy";
import type { TypedConfirmRequest } from "@/lib/guardrails/guard";

const props = defineProps<{ request: TypedConfirmRequest }>();
const emit = defineEmits<{ (e: "settle", confirmed: boolean): void }>();

const typed = ref("");
const matches = computed(() => phraseMatches(typed.value, props.request.phrase));
const inputId = computed(() => `typed-confirm-${props.request.id}`);

const submit = () => {
  if (matches.value) emit("settle", true);
};
</script>

<template>
  <AlertDialog
    :open="true"
    @update:open="(open: boolean) => !open && emit('settle', false)"
  >
    <AlertDialogContent class="max-w-md">
      <ul class="grid gap-1.5" aria-label="Clusters">
        <li
          v-for="cluster in request.clusters"
          :key="cluster.key"
          class="flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2"
          :class="
            cluster.protected
              ? 'border-destructive/25 bg-destructive/[0.06]'
              : 'bg-card'
          "
        >
          <ClusterLabel
            :context="cluster.context"
            :kube-config="cluster.kubeConfig"
            size="default"
            class="font-medium"
          />
          <span
            v-if="cluster.protected"
            class="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-destructive"
          >
            <ShieldAlert class="h-3.5 w-3.5" />
            Protected
          </span>
        </li>
      </ul>

      <AlertDialogHeader>
        <AlertDialogTitle class="break-words">{{ request.title }}</AlertDialogTitle>
        <AlertDialogDescription>
          Runs against {{ request.clusters.length > 1 ? "protected clusters" : "a protected cluster" }}.
          <template v-if="request.requireDryRun">The server-side dry run passed.</template>
        </AlertDialogDescription>
      </AlertDialogHeader>

      <!-- One target: the title names it. -->
      <ul
        v-if="request.targets.length > 1"
        class="max-h-40 space-y-0.5 overflow-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs"
        aria-label="Targets"
      >
        <li
          v-for="(line, index) in request.targets"
          :key="index"
          class="truncate"
          :title="line"
        >
          {{ line }}
        </li>
      </ul>

      <form class="grid gap-1.5" data-testid="typed-confirm" @submit.prevent="submit">
        <Label :for="inputId" class="font-normal text-muted-foreground">
          Type
          <span class="select-text font-mono font-medium text-foreground">{{
            request.phrase
          }}</span>
          to confirm
        </Label>
        <Input
          :id="inputId"
          v-model="typed"
          class="font-mono text-xs"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          data-testid="typed-confirm-input"
        />
        <AlertDialogFooter class="mt-3">
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
