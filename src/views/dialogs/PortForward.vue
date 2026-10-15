<script setup lang="ts">
/**
 * Start a forward: the object's ports by name ("http · 8080", http first),
 * a local port that's predictable (the one used last time, else the remote
 * port, else the next free one, and it says so when it moves), and while
 * it starts, what it is waiting for.
 */
import { watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Cable, Loader2 } from "lucide-vue-next";
import { V1Pod, V1Deployment, V1Service } from "@kubernetes/client-node";
import { useToast } from "@/components/ui/toast";
import { AlertDialogFooter } from "@/components/ui/alert-dialog";
import {
  PortForwardingActionsKey,
  PortForwardingAddPortForwarding,
  PortForwardingStateKey,
  type PortForwarding,
} from "@/providers/PortForwardingProvider";
import { injectStrict } from "@/lib/utils";
import {
  chooseLocalPort,
  containerPortOptions,
  defaultPortOption,
  isHttpPort,
  portCandidates,
  portLabel,
  servicePortOptions,
  type PortOption,
} from "@/lib/portForwardPorts";

const { toast } = useToast();
const addPortForwarding = injectStrict(PortForwardingAddPortForwarding);
const actions = injectStrict(PortForwardingActionsKey);
const { activePortForwardings } = injectStrict(PortForwardingStateKey);

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  object: V1Pod | V1Deployment | V1Service;
  /** Preselects a port (number or name), e.g. from a port in a side panel. */
  port?: number | string;
}>();
const emit = defineEmits(["closeDialog"]);

const objectType = computed<PortForwarding["objectType"]>(() =>
  props.object.kind === "Pod"
    ? "pod"
    : props.object.kind === "Deployment"
    ? "deployment"
    : "service"
);
const objectName = computed(() => props.object.metadata?.name ?? "");

const options = computed<PortOption[]>(() => {
  if (props.object.kind === "Service") {
    return servicePortOptions((props.object as V1Service).spec?.ports);
  }
  const containers =
    props.object.kind === "Deployment"
      ? (props.object as V1Deployment).spec?.template.spec?.containers
      : (props.object as V1Pod).spec?.containers;
  return containerPortOptions(containers);
});

/* Ports grouped by container when there's more than one. */
const groups = computed(() => {
  const byContainer = new Map<string, PortOption[]>();
  for (const option of options.value) {
    const key = option.container ?? "";
    byContainer.set(key, [...(byContainer.get(key) ?? []), option]);
  }
  return [...byContainer.entries()].map(([container, ports]) => ({
    container,
    ports,
  }));
});

const asked = options.value.find(
  (o) => props.port !== undefined && (o.port === props.port || o.name === props.port)
);
const selected = ref((asked ?? defaultPortOption(options.value))?.value ?? "");
const option = computed(() =>
  options.value.find((o) => o.value === selected.value)
);
// Nothing declared: kubectl lets you forward any port, so do we.
const typedPort = ref("");
const remotePort = computed(() =>
  option.value ? option.value.port : parseInt(typedPort.value) || 0
);

const model = ref({
  localPort: "",
  address: "localhost",
  openInBrowser: false,
  // TTL in hours; "0" (default) means keep running until stopped manually.
  ttlHours: "0",
});
const ttlSeconds = computed(() => {
  const hours = parseInt(model.value.ttlHours);
  return hours > 0 ? hours * 3600 : null;
});

const target = computed(() => ({
  context: props.context,
  namespace: props.namespace,
  objectType: objectType.value,
  objectName: objectName.value,
  objectPort: remotePort.value,
}));

/* -------------------------------------------------------- local port -- */

const note = ref<{ text: string; tone: "muted" | "warning" } | null>(null);
// The suggestion moved away from the remembered port: don't remember the
// detour, next time the usual port is tried again.
const movedAway = ref(false);
const typedLocal = ref(false);
let check = 0;

const freePorts = (ports: number[]) =>
  invoke<number[]>("check_local_ports", {
    address: model.value.address,
    ports,
  }).catch(() => ports);

const suggest = async () => {
  const remote = remotePort.value;
  if (!remote) return;
  const token = ++check;
  const remembered = actions.rememberedPort(target.value);
  const free = await freePorts(portCandidates(remote, remembered));
  if (token !== check) return;
  const choice = chooseLocalPort(remote, remembered, free);
  model.value.localPort = String(choice.port);
  note.value = choice.note ? { text: choice.note, tone: choice.tone } : null;
  movedAway.value = remembered !== undefined && choice.port !== remembered;
  typedLocal.value = false;
};
watch(remotePort, suggest, { immediate: true });
// Another address: suggest again, or re-check the port the user typed.
watch(
  () => model.value.address,
  () => (typedLocal.value ? onLocalInput() : suggest())
);

let typingTimer: ReturnType<typeof setTimeout> | undefined;
const onLocalInput = () => {
  typedLocal.value = true;
  movedAway.value = false;
  clearTimeout(typingTimer);
  const token = ++check;
  typingTimer = setTimeout(async () => {
    const port = parseInt(model.value.localPort);
    if (!(port > 0 && port < 65536)) {
      note.value = { text: "Pick a port from 1 to 65535", tone: "warning" };
      return;
    }
    const free = await freePorts([port]);
    if (token !== check) return;
    note.value = free.includes(port)
      ? null
      : { text: `${port} is in use`, tone: "warning" };
  }, 250);
};
onBeforeUnmount(() => clearTimeout(typingTimer));

/* ----------------------------------------------------------- forward -- */

const forwarding = ref(false);
const spec = computed<PortForwarding>(() => ({
  kubeConfig: props.kubeConfig,
  context: props.context,
  namespace: props.namespace,
  objectType: objectType.value,
  objectName: objectName.value,
  objectPort: remotePort.value,
  portName: option.value?.name,
  localPort: parseInt(model.value.localPort),
  address: model.value.address,
  ttlSeconds: ttlSeconds.value,
}));

/* What the starting forward waits for ("Waiting for a ready pod…"). */
const waitingFor = computed(() => {
  if (!forwarding.value) return null;
  const s = spec.value;
  return (
    activePortForwardings.value.find(
      (pf) =>
        pf.status === "starting" &&
        pf.context === s.context &&
        pf.namespace === s.namespace &&
        pf.objectName === s.objectName &&
        pf.objectPort === s.objectPort &&
        pf.localPort === s.localPort
    )?.reason ?? null
  );
});

const canForward = computed(
  () =>
    !forwarding.value &&
    remotePort.value > 0 &&
    spec.value.localPort > 0 &&
    spec.value.localPort < 65536 &&
    !!model.value.address.trim()
);

const portForward = async () => {
  if (!canForward.value) return;
  forwarding.value = true;
  const request = spec.value;
  try {
    await addPortForwarding(
      request,
      model.value.openInBrowser && httpish.value
    );
    if (!movedAway.value || typedLocal.value) {
      actions.rememberPort(target.value, request.localPort);
    }
    toast({
      title: "Port forwarded",
      description: `${objectName.value} · ${portLabel(
        request.portName,
        request.objectPort
      )} is on ${request.address}:${request.localPort}`,
      autoDismiss: true,
    });
    emit("closeDialog");
  } catch (error: unknown) {
    toast({
      title: "Couldn't forward the port",
      description:
        error instanceof Error ? error.message : String(error ?? "Unknown error"),
      variant: "destructive",
      autoDismiss: true,
    });
  } finally {
    forwarding.value = false;
  }
};

const httpish = computed(() =>
  isHttpPort(option.value?.name, remotePort.value)
);
</script>
<template>
  <form
    class="grid grid-cols-[6.5rem_1fr] items-center gap-x-4 gap-y-3"
    @submit.prevent="portForward"
  >
    <Label for="pf-remote-port" class="text-muted-foreground">Port</Label>
    <Select v-if="options.length > 0" v-model="selected">
      <SelectTrigger id="pf-remote-port" aria-label="Port">
        <SelectValue placeholder="Select a port" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup v-for="group in groups" :key="group.container">
          <SelectLabel v-if="groups.length > 1">{{ group.container }}</SelectLabel>
          <SelectItem
            v-for="port in group.ports"
            :key="port.value"
            :value="port.value"
          >
            <span v-if="port.name">{{ port.name }}</span>
            <span
              class="tabular-nums"
              :class="port.name ? 'text-muted-foreground' : ''"
              >{{ port.name ? " · " : "" }}{{ port.port }}</span
            >
            <span
              v-if="typeof port.targetPort === 'number' && port.targetPort !== port.port"
              class="text-muted-foreground"
            >
              → {{ port.targetPort }}</span
            >
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
    <div v-else class="space-y-1">
      <Input
        id="pf-remote-port"
        v-model="typedPort"
        inputmode="numeric"
        placeholder="8080"
        class="tabular-nums"
      />
      <p class="text-xs text-muted-foreground">
        No ports are declared. Enter the one the app listens on.
      </p>
    </div>

    <Label for="pf-local-port" class="self-start pt-2 text-muted-foreground"
      >Local port</Label
    >
    <div class="space-y-1">
      <Input
        id="pf-local-port"
        v-model="model.localPort"
        inputmode="numeric"
        class="tabular-nums"
        :aria-describedby="note ? 'pf-local-note' : undefined"
        @input="onLocalInput"
      />
      <p
        v-if="note"
        id="pf-local-note"
        class="text-xs"
        :class="note.tone === 'warning' ? 'text-warning' : 'text-muted-foreground'"
      >
        {{ note.text }}
      </p>
    </div>

    <Label for="pf-address" class="text-muted-foreground">Address</Label>
    <Input id="pf-address" v-model="model.address" class="font-mono text-xs" />

    <Label for="pf-ttl" class="text-muted-foreground">Auto-stop</Label>
    <Select v-model="model.ttlHours">
      <SelectTrigger id="pf-ttl">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="0">Never</SelectItem>
          <SelectItem value="1">After 1 hour</SelectItem>
          <SelectItem value="4">After 4 hours</SelectItem>
          <SelectItem value="8">After 8 hours</SelectItem>
          <SelectItem value="24">After 24 hours</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>

    <template v-if="httpish">
      <span aria-hidden="true"></span>
      <div class="flex items-center gap-2">
        <Checkbox
          id="open-in-browser"
          :checked="model.openInBrowser"
          @update:checked="model.openInBrowser = $event"
        />
        <Label for="open-in-browser" class="font-normal">Open in browser</Label>
      </div>
    </template>
  </form>
  <AlertDialogFooter class="items-center">
    <p
      v-if="waitingFor"
      class="mr-auto min-w-0 truncate text-xs text-muted-foreground"
      aria-live="polite"
    >
      {{ waitingFor }}…
    </p>
    <Button variant="ghost" @click="emit('closeDialog')">Cancel</Button>
    <Button variant="default" :disabled="!canForward" @click="portForward">
      <Loader2 v-if="forwarding" class="h-3.5 w-3.5 animate-spin" />
      <Cable v-else class="h-3.5 w-3.5" />
      {{ forwarding ? "Forwarding" : "Forward" }}
    </Button>
  </AlertDialogFooter>
</template>
