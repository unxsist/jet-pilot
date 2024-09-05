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
    .catch((error) => {
      toast({
        title: "Could not forward port",
        description: error,
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
  <div class="flex items-center">
    <div class="w-1/3 flex-shrink-0"><Label for="">Container Port</Label></div>
    <Select v-model="portForwardModel.containerPort">
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Container and Port</SelectLabel>
          <template v-for="container in containersWithPorts">
            <SelectItem
              v-for="port in container.ports"
              :key="port"
              :value="`${container.name}:${port}`"
            >
              {{ container.name }}:{{ port }}
            </SelectItem>
          </template>
        </SelectGroup>
      </SelectContent>
    </Select>
  </div>
  <div class="flex items-center">
    <div class="w-1/3 flex-shrink-0"><Label for="">Local Port</Label></div>
    <Input v-model="portForwardModel.localPort" />
  </div>
  <div class="flex items-center">
    <div class="w-1/3 flex-shrink-0"><Label for="">Address</Label></div>
    <Input v-model="portForwardModel.address" />
  </div>
  <div class="flex items-center">
    <div class="w-1/3 flex-shrink-0"></div>
    <Checkbox
      id="open-in-browser"
      v-model="portForwardModel.openInBrowser"
      :checked="portForwardModel.openInBrowser"
      @update:checked="portForwardModel.openInBrowser = $event"
    />
    <Label for="open-in-browser" class="ml-2">Open in Browser</Label>
  </div>
  <AlertDialogFooter>
    <Button variant="default" @click="emit('closeDialog')">Cancel</Button>
    <Button variant="default" @click="portForward">Forward</Button>
  </AlertDialogFooter>
</template>
