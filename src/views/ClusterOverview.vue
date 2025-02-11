<script setup lang="ts">
import SpotlightGridContainer from "@/components/ui/SpotlightGridContainer.vue";
import type { Node, Edge } from "@vue-flow/core";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import { onMounted } from "vue";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { Kubernetes } from "@/services/Kubernetes";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import { KubernetesObject, V1APIResource } from "@kubernetes/client-node";
import ObjectNode from "@/components/vue-flow/ObjectNode.vue";
import jsonpath from "jsonpath";

const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

const apiResources = ref<V1APIResource[]>([]);
const failedResources = ref<V1APIResource[]>([]);
const objects = ref<Map<string, KubernetesObject[]>>(new Map());
const loadingState = ref<string>("");

const nodes = ref<Node[]>([]);
const { fitView } = useVueFlow();

const edges = ref<Edge[]>([]);

const layoutNodes = (
  nodes,
  padding = { top: 50, left: 25, bottom: 0, right: 25 }
) => {
  const NODE_WIDTH = 150;
  const NODE_HEIGHT = 120;
  const MARGIN = 25;
  const MAX_PER_ROW = 5;

  let nodeMap = new Map();
  let childrenMap = new Map();

  nodes.forEach((node) => {
    nodeMap.set(node.id, node);
    if (node.parentNode) {
      if (!childrenMap.has(node.parentNode)) {
        childrenMap.set(node.parentNode, []);
      }
      childrenMap.get(node.parentNode).push(node);
    }
  });

  function calculatePositions(nodeId) {
    let node = nodeMap.get(nodeId);
    let children = childrenMap.get(nodeId) || [];

    let width = NODE_WIDTH;
    let height = NODE_HEIGHT;
    let childPositions = [];

    if (children.length > 0) {
      let x = padding.left,
        y = padding.top;
      let maxRowWidth = 0;
      let currentRowWidth = 0;
      let rowHeight = 0;
      let totalHeight = padding.top;

      children.forEach((child, index) => {
        let childPos = calculatePositions(child.id);
        child.position = { x, y };
        childPositions.push({
          x,
          y,
          width: childPos.width,
          height: childPos.height,
        });

        x += childPos.width + MARGIN;
        currentRowWidth += childPos.width + MARGIN;
        rowHeight = Math.max(rowHeight, childPos.height + MARGIN);
        maxRowWidth = Math.max(maxRowWidth, currentRowWidth);

        if ((index + 1) % MAX_PER_ROW === 0) {
          x = padding.left;
          y += rowHeight;
          totalHeight += rowHeight;
          currentRowWidth = 0;
          rowHeight = 0;
        }
      });

      width = maxRowWidth + padding.right; // Ensure right-side padding
      height = totalHeight + rowHeight + padding.bottom;
    }

    if (!node.style) {
      node.style = {};
    }

    node.style.width = `${width}px`;
    node.style.height = `${height}px`;

    if (children.length > 0) {
      let minX = Math.min(...childPositions.map((pos) => pos.x));
      let maxX = Math.max(...childPositions.map((pos) => pos.x + pos.width));
      node.position = {
        x: (minX + maxX) / 2 - NODE_WIDTH / 2,
        y: height / 2 - NODE_HEIGHT / 2,
      };
    }

    return {
      width,
      height,
      x: node.position?.x || 0,
      y: node.position?.y || 0,
    };
  }

  let roots = nodes.filter((node) => !node.parentNode);
  let x = 0;
  roots.forEach((root) => {
    let rootPos = calculatePositions(root.id);
    root.position = { x, y: 0 };
    x += rootPos.width + MARGIN;
  });

  return nodes;
};

const layoutGraph = () => {
  nodes.value = layoutNodes(nodes.value);

  nextTick(() => {
    fitView();
  });
};

const mapObjectsToNodes = () => {
  const topLevelObjects = [...objects.value.values()]
    .flat()
    .filter((object) => {
      return !object.metadata.ownerReferences;
    });

  nodes.value.push(
    ...topLevelObjects.map((object): Node => {
      return {
        id: object.metadata?.uid || object.metadata?.name,
        data: { label: object.metadata?.name, kubeObject: object, level: 0 },
        position: { x: 0, y: 0 },
        type: "kubernetes-object",
        class:
          "overflow-hidden bg-background border border-muted rounded text-white hover:border-white",
      };
    })
  );

  nodes.value.forEach((node) => {
    resolveChildNodesForParent(node, 1);
  });
};

/** Mapping of how kubernetes object relate to each other and the json path to be able to determine that */
const specLinks: [string, string, string[]][] = [
  [
    "Deployment",
    "ConfigMap",
    ["$.spec.template.spec.volumes.*.configMap.name"],
  ],
];

const resolveEdges = () => {
  const topLevelObjects = [...objects.value.values()]
    .flat()
    .filter((object) => {
      return !object.metadata.ownerReferences;
    });

  topLevelObjects.forEach((object) => {
    specLinks.forEach(([sourceKind, targetKind, queries]) => {
      if (object.kind === sourceKind) {
        queries.forEach((query) => {
          const targets = jsonpath.query(object, query);

          targets.forEach((targetName) => {
            const target = objects.value.get(targetKind)?.find((obj) => {
              return obj.metadata.name === targetName;
            });

            if (target) {
              edges.value.push({
                id: `${object.metadata.uid}-${target.metadata.uid}`,
                source: object.metadata.uid || object.metadata.name,
                target: target.metadata.uid || target.metadata.name,
                type: "kubernetes-object",
              });
            }
          });
        });
      }
    });
  });
};

const resolveChildNodesForParent = (parent: Node, level: number) => {
  const children = [...objects.value.values()].flat().filter((object) => {
    return (
      object.metadata.ownerReferences &&
      object.metadata.ownerReferences.some(
        (ref) => ref.uid === parent.data.kubeObject.metadata.uid
      )
    );
  });

  children.forEach((child) => {
    const node = {
      id: child.metadata.uid || child.metadata.name,
      data: { label: child.metadata.name, kubeObject: child, level: level },
      position: { x: 0, y: 0 },
      parentNode: child.metadata.ownerReferences?.[0].uid || "",
      expandParent: true,
      type: "kubernetes-object",
      class:
        "overflow-hidden bg-background border border-muted rounded text-white nodrag hover:border-white",
    } as Node;

    nodes.value.push(node);

    resolveChildNodesForParent(node, level + 1);
  });
};

const fetchResourceObjects = (resource: V1APIResource): Promise<void> => {
  return new Promise(async (resolve) => {
    console.log(`Fetching objects for ${resource.name}`);
    const args = [
      "get",
      formatResourceKind(resource.kind).toLowerCase(),
      "--context",
      context.value,
      "-n",
      namespace.value,
      "-o",
      "json",
      "--kubeconfig",
      kubeConfig.value,
    ];

    try {
      const result = await Kubernetes.kubectl(args);
      objects.value.set(resource.kind, JSON.parse(result).items);
    } catch (error) {
      failedResources.value.push(resource);
      return;
    }

    resolve();
  });
};

const fetchAllResources = async () => {
  loadingState.value = "Fetching resources...";

  const versions = await Kubernetes.getCoreApiVersions(context.value);
  for (const version of versions) {
    const resources = await Kubernetes.getCoreApiResources(
      context.value,
      version
    );

    apiResources.value.push(
      ...resources.filter((resource) => {
        return (
          !resource.name.includes("/") &&
          resource.namespaced &&
          resource.name !== "events"
        );
      })
    );
  }

  // dedupe based on kind
  apiResources.value = apiResources.value.filter(
    (resource, index, self) =>
      index === self.findIndex((r) => r.kind === resource.kind)
  );

  const groups = await Kubernetes.getApiGroups(context.value);
  for (const group of groups) {
    const resources = await Kubernetes.getApiGroupResources(
      context.value,
      group.preferredVersion?.groupVersion || ""
    );

    apiResources.value.push(
      ...resources.filter((resource) => {
        return (
          !resource.name.includes("/") &&
          resource.namespaced &&
          resource.name !== "events"
        );
      })
    );
  }

  apiResources.value = apiResources.value.filter((resource) => {
    return (
      resource.kind === "Pod" ||
      resource.kind === "Deployment" ||
      resource.kind === "ReplicaSet" ||
      resource.kind === "ConfigMap"
    );
  });

  for (const resource of apiResources.value) {
    fetchResourceObjects(resource).then(() => {
      if (
        objects.value.size + failedResources.value.length ===
        apiResources.value.length
      ) {
        loadingState.value = "";

        mapObjectsToNodes();
        resolveEdges();
        layoutGraph();

        //create nodes for all pods
        // const nodesArray: Node[] = [];
        // objects.value.forEach((objects, kind) => {
        //   if (kind === "Pod") {
        //     objects.forEach((object) => {
        //       nodesArray.push({
        //         id: object.metadata.name,
        //         data: { label: object.metadata.name },
        //         position: { x: 0, y: 0 },
        //       });
        //     });
        //   }
        // });
        // nodes.value = nodesArray;
      }
    });
  }
};

onMounted(async () => {
  await fetchAllResources();
});
</script>
<template>
  <SpotlightGridContainer>
    <div
      v-if="loadingState !== ''"
      class="absolute top-0 left-0 bottom-0 right-0 flex items-center justify-center backdrop-blur-sm"
    >
      {{ loadingState }}
      <span class="ml-2" v-if="apiResources.length > 0"
        >({{ objects.size + failedResources.length }}/{{
          apiResources.length
        }})</span
      >
    </div>
    <VueFlow v-else :nodes="nodes" :edges="edges" fit-view-on-init>
      <template #node-kubernetes-object="props">
        <ObjectNode v-bind="props" />
      </template>
    </VueFlow>
  </SpotlightGridContainer>
</template>
<style>
/* import the necessary styles for Vue Flow to work */
@import "@vue-flow/core/dist/style.css";

/* import the default theme, this is optional but generally recommended */
@import "@vue-flow/core/dist/theme-default.css";
</style>
