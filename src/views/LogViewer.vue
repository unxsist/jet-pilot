<script setup lang="ts">
import { Button } from "@/components/ui/button";
import { Child, Command } from "@tauri-apps/api/shell";
import { useMagicKeys, useVirtualList } from "@vueuse/core";
import { Input } from "@/components/ui/input";

const props = defineProps<{
  context: string;
  namespace: string;
  object: string;
}>();

const search = ref(false);
const searchInput = ref<typeof Input | null>(null);
const searchQuery = ref("");
const autoScroll = ref(true);
const logContainer = ref<HTMLPreElement | null>(null);
const logs = ref<string[]>([]);
const logsSince = ref<string>("5m");
let logProcess: Child | null = null;

const { Cmd_F, Ctrl_F, Escape } = useMagicKeys();

watch([Cmd_F, Ctrl_F, Escape], ([mac, win, esc]) => {
  if (mac || win) {
    search.value = !search.value;

    if (search.value) {
      searchInput.value?.focus(); 
    }
  } 

  if (esc) {
    search.value = false;
  }
});

const filteredLogs = computed(() => {
  return logs.value.filter((log) => {
    return log.includes(searchQuery.value);
  });
});

const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(filteredLogs, {itemHeight: 10});

const logsSinceOptions = [
  {
    label: "tail",
    value: "tail",
  },
  {
    label: "1 minute",
    value: "1m",
  },
  {
    label: "5 minutes",
    value: "5m",
  },
  {
    label: "15 minutes",
    value: "15m",
  },
  {
    label: "30 minutes",
    value: "30m",
  },
  {
    label: "1 hour",
    value: "1h",
  },
];

const initCommand = computed(() => {
  const initCommandArgs = [
    "logs",
    "--context",
    props.context,
    "--namespace",
    props.namespace,
  ];

  if (logsSince.value !== "tail" && logsSince.value !== "head") {
    initCommandArgs.push("--since=" + logsSince.value);
  }

  if (logsSince.value === "tail") {
    initCommandArgs.push("--tail=100");
  }

  initCommandArgs.push("--follow");

  initCommandArgs.push(props.object);

  return initCommandArgs;
});

const initLogOutput = async () => {
  killProcess();

  logs.value = [];

  const command = new Command("kubectl", initCommand.value);

  command.stdout.on("data", (data) => {
    logs.value.push(data);

    if (autoScroll.value) {
      scrollTo(logs.value.length - 1);
    }
  });

  command.stderr.on("data", (data) => {
    logs.value.push(data);

    if (autoScroll.value) {
      scrollTo(logs.value.length - 1);
    }
  });

  const child = await command.spawn();
  logProcess = child;
};

const setLogsSince = (value: string) => {
  logsSince.value = value;
  initLogOutput();
};

const killProcess = () => {
  if (logProcess) {
    logProcess.kill();
  }
};

onMounted(() => {
  initLogOutput();
});

onUnmounted(() => {
  killProcess();
});

const onWheel = (e: WheelEvent) => {
  if (e.deltaY < 0) {
    autoScroll.value = false;
  }
};
</script>
<template>
  <div class="group relative flex flex-col h-full w-full">
    <div class="absolute top-0 right-0 w-full max-w-sm" v-show="search">
      <Input ref="searchInput" class="bg-background" v-model="searchQuery" placeholder="Search logs..." />
    </div>
    <div v-bind="containerProps" v-on:wheel="onWheel">
      <pre class="flex-grow w-full" ref="logContainer" v-bind="wrapperProps">
          <span v-for="logline in list" :key="logline.index">{{ logline.data }}</span>
      </pre>
    </div>
    <div
      class="absolute bottom-5 right-5 flex justify-end space-x-1 transition-opacity opacity-25 group-hover:opacity-100"
    >
      <Button v-if="!autoScroll" size="xs" @click="autoScroll = !autoScroll">
        Auto scroll</Button>
      <Button
        :variant="logsSince === age.value ? 'default' : 'secondary'"
        v-for="age in logsSinceOptions"
        :key="age.value"
        size="xs"
        @click="setLogsSince(age.value)"
      >
        {{ age.value }}
      </Button>
    </div>
  </div>
</template>
