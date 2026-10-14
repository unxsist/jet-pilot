<script setup lang="ts">
import { useRouter } from "vue-router";
import { toast } from "@/components/ui/toast";
import ReleaseKindGroup from "./ReleaseKindGroup.vue";
import { apiPath, kubeGet } from "@/lib/kubeApi";
import { errorText } from "@/lib/auth/classify";
import { formatResourceKind } from "@/lib/utils";
import { groupByKind, type ManifestObject } from "@/lib/helm";

/*
 * What a release installed, grouped by kind, with live health where the
 * app watches the kind. Clicking an object goes to it in its list.
 */
const props = defineProps<{
  objects: ManifestObject[];
  context: string;
  kubeConfig: string;
  namespace: string;
}>();

const router = useRouter();
const groups = computed(() => groupByKind(props.objects));

const open = async (object: ManifestObject, live: any | null) => {
  const resource = formatResourceKind(object.kind).toLowerCase();
  let uid: string | undefined = live?.metadata?.uid;
  if (!uid) {
    try {
      const found = await kubeGet<any>(
        { context: props.context, kubeConfig: props.kubeConfig },
        apiPath({
          apiVersion: object.apiVersion || "v1",
          resource,
          namespace: object.namespace || undefined,
          name: object.name,
        })
      );
      uid = found?.metadata?.uid;
    } catch (e) {
      toast({
        title: `Can't find ${object.kind.toLowerCase()} ${object.name}`,
        description: errorText(e),
        variant: "destructive",
      });
      return;
    }
  }
  router.push({
    path: `/${resource}`,
    query: { resource, kind: object.kind, uid },
  });
};
</script>

<template>
  <div class="-mx-2 space-y-2.5">
    <ReleaseKindGroup
      v-for="group in groups"
      :key="group.kind"
      :kind="group.kind"
      :objects="group.objects"
      :context="context"
      :kube-config="kubeConfig"
      :namespace="namespace"
      @open="open"
    />
  </div>
</template>
