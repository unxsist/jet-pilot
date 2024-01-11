<script setup lang="ts">
import Loading from "@/components/Loading.vue";
import { Command } from "@tauri-apps/api/shell";
import loader from "@monaco-editor/loader";
import Theme from "@/components/monaco/themes/BrillianceBlack";

const props = defineProps<{
  context: string;
  namespace: string;
  object: string;
}>();

const editContents = ref<string>("");

onMounted(() => {
  const command = new Command("kubectl", [
    "get",
    props.object,
    "--context",
    props.context,
    "--namespace",
    props.namespace,
    "-o",
    "yaml",
  ]);

  let stdOutData = "";
  command.stdout.on("data", (data) => {
    stdOutData += data;
  });

  command.on("close", ({ code }) => {
    if (code === 0) {
      editContents.value = stdOutData;

      loader.init().then((monaco) => {
        monaco.editor.defineTheme("BrillianceBlack", Theme);
        monaco.editor.create(document.getElementById("editor")!, {
          value: stdOutData,
          language: "yaml",
          theme: "BrillianceBlack",
          automaticLayout: true,
          minimap: {
            enabled: false,
          },
        });
      });
    }
  });

  command.spawn();
});
</script>
<template>
  <Loading label="loading..." v-if="editContents.length === 0" />
  <div id="editor" class="w-full h-full"></div>
</template>
@/components/monaco/themes/BrillianceBlack
