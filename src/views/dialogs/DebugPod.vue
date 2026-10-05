<script setup lang="ts">
import { V1Pod } from "@kubernetes/client-node";
import { Bug } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import DebugImagePicker from "@/components/workloads/DebugImagePicker.vue";
import { getResourceTabId, getResourceTabTitle } from "@/components/tables/identity";
import { DEBUG_IMAGES, kubectlDebugPodCommand } from "@/lib/workloads";
import { injectStrict } from "@/lib/utils";
import { SettingsContextStateKey } from "@/providers/SettingsContextProvider";
import { guard, rowTargets } from "@/lib/guardrails/guard";

/*
 * Starts `kubectl debug -it <pod> --image=… --target=<container>` in a pty
 * tab: an ephemeral container sharing the target container's process
 * namespace (ps, /proc/<pid>/root, …).
 */
const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  pod: V1Pod & { metadata: { context: string; kubeConfig: string } };
  addTab: (...args: any[]) => void;
}>();
const emit = defineEmits(["closeDialog"]);

const NO_TARGET = "__none__";

const containers = computed(() =>
  (props.pod.spec?.containers ?? []).map((c) => c.name)
);
/* Settings › Advanced › Debugging. */
const { settings } = injectStrict(SettingsContextStateKey);
const image = ref(settings.value.debug.defaultImage || DEBUG_IMAGES[0].image);
const targetContainer = ref(containers.value[0] ?? NO_TARGET);

const start = async () => {
  if (!image.value.trim()) return;
  if (!(await guard("debug", rowTargets([props.pod], "Pod")))) return;
  const pod = props.pod.metadata?.name ?? "";
  const target = targetContainer.value === NO_TARGET ? undefined : targetContainer.value;
  const argv = kubectlDebugPodCommand({
    pod,
    image: image.value.trim(),
    target,
    cluster: props,
  });

  props.addTab(
    getResourceTabId("debug", props.pod, `${Date.now()}`),
    `${getResourceTabTitle(props.pod)} debug`,
    defineAsyncComponent(() => import("@/views/DebugShell.vue")),
    {
      context: props.context,
      namespace: props.namespace,
      kubeConfig: props.kubeConfig,
      argv,
      banner:
        `Ephemeral container ${image.value.trim()} in ${pod}` +
        (target ? `, sharing the processes of ${target}` : "") +
        ". It stays in the pod spec until the pod is replaced.",
    },
    "debug"
  );
  emit("closeDialog");
};
</script>

<template>
  <form class="grid gap-4" @submit.prevent="start">
    <div class="grid gap-1.5">
      <Label>Image</Label>
      <DebugImagePicker v-model="image" :presets="DEBUG_IMAGES" />
    </div>
    <div class="grid gap-1.5">
      <Label for="debug-target">Target container</Label>
      <Select v-model="targetContainer">
        <SelectTrigger id="debug-target" class="font-mono text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="name in containers" :key="name" :value="name" class="font-mono text-xs">
            {{ name }}
          </SelectItem>
          <SelectItem :value="NO_TARGET" class="text-xs">No target (own process namespace)</SelectItem>
        </SelectContent>
      </Select>
      <p class="text-xs text-muted-foreground">
        Needs ephemeral container support (Kubernetes 1.25+) and permission to
        update <span class="font-mono">pods/ephemeralcontainers</span>.
      </p>
    </div>
    <AlertDialogFooter>
      <Button type="button" variant="ghost" @click="emit('closeDialog')">Cancel</Button>
      <Button type="submit" :disabled="!image.trim()">
        <Bug class="h-3.5 w-3.5" />
        Start debugging
      </Button>
    </AlertDialogFooter>
  </form>
</template>
