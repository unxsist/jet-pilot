<script setup lang="ts">
import { injectStrict } from "@/lib/utils";
import { ShowSingleCommandKey } from "@/providers/CommandPaletteProvider";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";

const showSingleCommand = injectStrict(ShowSingleCommandKey);
const { context, namespace } = injectStrict(KubeContextStateKey);
</script>
<template>
  <div class="w-full mt-2 mb-4 pr-2">
    <button
      class="flex flex-col w-full text-xs border rounded-lg p-2 text-left hover:bg-background"
      @click="showSingleCommand('switch-context')"
    >
      <span class="uppercase font-bold mb-1">{{ context }}</span>
      <span>{{ namespace == "all" ? "All namespaces" : namespace }}</span>
    </button>
  </div>
</template>
