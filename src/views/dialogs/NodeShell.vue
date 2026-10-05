<script setup lang="ts">
import { ShieldAlert, SquareTerminal } from "lucide-vue-next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import DebugImagePicker from "@/components/workloads/DebugImagePicker.vue";
import { getResourceTabId } from "@/components/tables/identity";
import { kubectlNodeShellCommand } from "@/lib/workloads";
import { guard } from "@/lib/guardrails/guard";

/*
 * Root shell on a node through `kubectl debug node/<node> --profile=sysadmin`:
 * a privileged pod in the host namespaces with the node filesystem at /host
 * (chroot'ed into by default). The pod is removed when the session ends.
 */
const props = defineProps<{
  context: string;
  kubeConfig: string;
  node: { metadata?: { name?: string; context?: string } };
  addTab: (...args: any[]) => void;
}>();
const emit = defineEmits(["closeDialog"]);

const NODE_IMAGES = [
  { image: "busybox:1.36", label: "busybox", description: "Tiny shell with core utilities" },
  { image: "nicolaka/netshoot", label: "netshoot", description: "Network tools: tcpdump, dig, curl, iperf, …" },
  { image: "ubuntu:24.04", label: "ubuntu", description: "Full userland with apt" },
];

const nodeName = computed(() => props.node.metadata?.name ?? "");
const image = ref(NODE_IMAGES[0].image);
const chroot = ref(true);
const namespace = ref("default");
const acknowledged = ref(false);

const start = async () => {
  if (!acknowledged.value || !image.value.trim() || !namespace.value.trim()) return;
  const target = {
    context: props.context,
    kubeConfig: props.kubeConfig,
    name: nodeName.value,
    kind: "Node",
  };
  if (!(await guard("node-shell", [target]))) return;
  const cluster = {
    context: props.context,
    namespace: namespace.value.trim(),
    kubeConfig: props.kubeConfig,
  };
  props.addTab(
    getResourceTabId("node-shell", props.node, `${Date.now()}`),
    `node/${nodeName.value}`,
    defineAsyncComponent(() => import("@/views/DebugShell.vue")),
    {
      ...cluster,
      argv: kubectlNodeShellCommand({
        node: nodeName.value,
        image: image.value.trim(),
        cluster,
        chroot: chroot.value,
      }),
      cleanupDebugPod: true,
      banner: `Root shell on node ${nodeName.value} (privileged pod in ${cluster.namespace}, deleted when the session ends).`,
    },
    "shell"
  );
  emit("closeDialog");
};
</script>

<template>
  <form class="grid gap-4" @submit.prevent="start">
    <Alert variant="destructive">
      <ShieldAlert />
      <AlertTitle>Root access to {{ nodeName }}</AlertTitle>
      <AlertDescription class="text-foreground">
        Creates a <strong>privileged</strong> pod in the node's host network,
        PID and IPC namespaces with the node's root filesystem mounted at
        <span class="font-mono">/host</span>. Commands can change or break the
        node and every pod on it. Requires permission to create privileged pods
        (Pod Security <span class="font-mono">privileged</span>).
      </AlertDescription>
    </Alert>

    <div class="grid gap-1.5">
      <Label>Image</Label>
      <DebugImagePicker v-model="image" :presets="NODE_IMAGES" />
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="grid gap-1.5">
        <Label for="node-shell-namespace">Namespace of the debug pod</Label>
        <Input id="node-shell-namespace" v-model="namespace" class="font-mono text-xs" />
      </div>
      <label class="flex cursor-pointer items-start gap-2 pt-6 text-sm">
        <Checkbox :checked="chroot" class="mt-0.5" @update:checked="chroot = $event === true" />
        <span>
          chroot into <span class="font-mono">/host</span>
          <span class="block text-xs text-muted-foreground">Use the node's own binaries</span>
        </span>
      </label>
    </div>

    <label class="flex cursor-pointer items-start gap-2 rounded-md border border-destructive/25 bg-destructive/[0.04] px-3 py-2 text-sm">
      <Checkbox
        :checked="acknowledged"
        class="mt-0.5"
        @update:checked="acknowledged = $event === true"
      />
      <span>I understand this grants root on the node</span>
    </label>

    <AlertDialogFooter>
      <Button type="button" variant="ghost" @click="emit('closeDialog')">Cancel</Button>
      <Button type="submit" variant="destructive" :disabled="!acknowledged || !image.trim() || !namespace.trim()">
        <SquareTerminal class="h-3.5 w-3.5" />
        Open node shell
      </Button>
    </AlertDialogFooter>
  </form>
</template>
