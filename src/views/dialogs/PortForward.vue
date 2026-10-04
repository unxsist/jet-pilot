<script setup lang="ts">
import { watch } from "vue";
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
import { ArrowRight, Cable } from "lucide-vue-next";
import { V1Pod, V1Deployment, V1Service } from "@kubernetes/client-node";
import { useToast } from "@/components/ui/toast";
const { toast } = useToast();

import { PortForwardingAddPortForwarding } from "@/providers/PortForwardingProvider";
import { injectStrict } from "@/lib/utils";

const addPortForwarding = injectStrict(PortForwardingAddPortForwarding);

import { AlertDialogFooter } from "@/components/ui/alert-dialog";

const props = defineProps<{
  context: string;
  namespace: string;
  kubeConfig: string;
  object: V1Pod | V1Deployment | V1Service;
}>();

const portForwardModel = ref({
  containerPort: "",
  localPort: "",
  address: "localhost",
  openInBrowser: false,
  // TTL in hours; "0" (default) means keep running until stopped manually.
  ttlHours: "0",
});

const ttlSeconds = computed(() => {
  const hours = parseInt(portForwardModel.value.ttlHours);
  return hours > 0 ? hours * 3600 : null;
});

const isV1Pod = (object: V1Pod | V1Deployment | V1Service): object is V1Pod => {
  return object.kind === "Pod";
};

const isV1Deployment = (
  object: V1Pod | V1Deployment | V1Service
): object is V1Deployment => {
  return object.kind === "Deployment";
};

const isV1Service = (
  object: V1Pod | V1Deployment | V1Service
): object is V1Service => {
  return object.kind === "Service";
};

const containersWithPorts = computed(() => {
  if (isV1Pod(props.object)) {
    return props.object.spec?.containers
      .filter((container) => container.ports?.length)
      .map((container) => {
        return {
          name: props.object.metadata?.name,
          ports:
            container.ports
              ?.filter((port) => port.protocol === "TCP")
              .map((port) => port.containerPort) ?? [],
        };
      });
  }

  if (isV1Deployment(props.object)) {
    return props.object.spec?.template.spec?.containers
      .filter((container) => container.ports?.length)
      .map((container) => {
        return {
          name: props.object.metadata?.name,
          ports:
            container.ports
              ?.filter((port) => port.protocol === "TCP")
              .map((port) => port.containerPort) ?? [],
        };
      });
  }

  if (isV1Service(props.object)) {
    return [
      {
        name: props.object.metadata?.name,
        ports:
          props.object.spec?.ports
            ?.filter((port) => port.protocol === "TCP")
            .map((port) => port.port) ?? [],
      },
    ];
  }

  return [];
});

watch(
  () => portForwardModel.value.containerPort,
  (containerPort) => {
    const [, port] = containerPort.split(":");
    portForwardModel.value.localPort = port;
  }
);

const emit = defineEmits(["closeDialog"]);

const portForward = () => {
  addPortForwarding(
    {
      kubeConfig: props.kubeConfig,
      context: props.context,
      namespace: props.namespace,
      objectType: isV1Pod(props.object)
        ? "pod"
        : isV1Deployment(props.object)
        ? "deployment"
        : "service",
      objectName: portForwardModel.value.containerPort.split(":")[0],
      objectPort: parseInt(portForwardModel.value.containerPort.split(":")[1]),
      localPort: parseInt(portForwardModel.value.localPort),
      address: portForwardModel.value.address,
      ttlSeconds: ttlSeconds.value,
    },
    portForwardModel.value.openInBrowser
  )
    .then(() => {
      toast({
        title: "Port Forwarded",
        description: `Port ${portForwardModel.value.containerPort} forwarded to ${portForwardModel.value.address}:${portForwardModel.value.localPort}`,
        autoDismiss: true,
      });
      emit("closeDialog");
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : String(error ?? "Unknown error");
      toast({
        title: "Could not forward port",
        description: message,
        variant: "destructive",
        autoDismiss: true,
      });
    });
};

onMounted(() => {
  if (containersWithPorts.value?.length) {
    portForwardModel.value.containerPort = `${containersWithPorts.value[0].name}:${containersWithPorts.value[0].ports[0]}`;
  }
});
</script>
<template>
  <div class="grid grid-cols-[7.5rem_1fr] items-center gap-x-4 gap-y-3">
    <Label for="pf-container-port" class="text-muted-foreground"
      >Container port</Label
    >
    <Select v-model="portForwardModel.containerPort">
      <SelectTrigger id="pf-container-port" class="font-mono text-xs">
        <SelectValue placeholder="Select a port" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Container and port</SelectLabel>
          <template v-for="container in containersWithPorts">
            <SelectItem
              v-for="port in container.ports"
              :key="port"
              :value="`${container.name}:${port}`"
              class="font-mono text-xs"
            >
              {{ container.name }}:{{ port }}
            </SelectItem>
          </template>
        </SelectGroup>
      </SelectContent>
    </Select>

    <Label for="pf-local-port" class="text-muted-foreground">Local port</Label>
    <Input
      id="pf-local-port"
      v-model="portForwardModel.localPort"
      inputmode="numeric"
      class="font-mono text-xs"
    />

    <Label for="pf-address" class="text-muted-foreground">Address</Label>
    <Input
      id="pf-address"
      v-model="portForwardModel.address"
      class="font-mono text-xs"
    />

    <Label for="pf-ttl" class="text-muted-foreground">Time to live</Label>
    <Select v-model="portForwardModel.ttlHours">
      <SelectTrigger id="pf-ttl">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Auto-stop after</SelectLabel>
          <SelectItem value="0">No auto-stop</SelectItem>
          <SelectItem value="1">1 hour</SelectItem>
          <SelectItem value="4">4 hours</SelectItem>
          <SelectItem value="8">8 hours</SelectItem>
          <SelectItem value="24">24 hours</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>

    <span aria-hidden="true"></span>
    <div class="flex items-center gap-2">
      <Checkbox
        id="open-in-browser"
        v-model="portForwardModel.openInBrowser"
        :checked="portForwardModel.openInBrowser"
        @update:checked="portForwardModel.openInBrowser = $event"
      />
      <Label for="open-in-browser" class="font-normal">Open in browser</Label>
    </div>
  </div>
  <div
    v-if="portForwardModel.containerPort && portForwardModel.localPort"
    class="flex items-center gap-2 rounded-md border bg-surface-1 px-3 py-2 font-mono text-xs text-muted-foreground"
  >
    <span class="truncate text-foreground">{{
      portForwardModel.containerPort
    }}</span>
    <ArrowRight class="h-3 w-3 shrink-0" />
    <span class="shrink-0 text-link"
      >{{ portForwardModel.address }}:{{ portForwardModel.localPort }}</span
    >
  </div>
  <AlertDialogFooter>
    <Button variant="ghost" @click="emit('closeDialog')">Cancel</Button>
    <Button variant="default" @click="portForward">
      <Cable class="h-3.5 w-3.5" />
      Forward
    </Button>
  </AlertDialogFooter>
</template>
