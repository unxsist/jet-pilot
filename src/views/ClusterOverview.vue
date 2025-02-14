<script setup lang="ts">
import SpotlightGridContainer from "@/components/ui/SpotlightGridContainer.vue";
import type { Node, Edge } from "@vue-flow/core";
import { MarkerType, VueFlow, useVueFlow } from "@vue-flow/core";
import { useLayout } from "@/composables/useDagreLayout";
import { onMounted } from "vue";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { Kubernetes } from "@/services/Kubernetes";
import { KubeContextStateKey } from "@/providers/KubeContextProvider";
import {
  KubernetesObject,
  V1APIResource,
  V1ReplicaSet,
  V1Secret,
} from "@kubernetes/client-node";
import ObjectNode from "@/components/vue-flow/ObjectNode.vue";
import PodsObjectNode from "@/components/vue-flow/PodsObjectNode.vue";
import specLinks from "@/lib/kubernetesSpecLinks";
import jsonpath from "jsonpath";
import jsonata from "jsonata";
import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";

const { context, namespace, kubeConfig } = injectStrict(KubeContextStateKey);

const apiResources = ref<V1APIResource[]>([]);
const failedResources = ref<V1APIResource[]>([]);
const objects = ref<Map<string, KubernetesObject[]>>(new Map());
const loadingState = ref<string>("");

const nodes = ref<Node[]>([]);
const {
  fitView,
  onNodeMouseEnter,
  onNodeMouseLeave,
  onNodeClick,
  findEdge,
  onNodesChange,
  findNode,
} = useVueFlow();
const { layout: dagreLayout } = useLayout();

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

const layoutTopLevelNodes = () => {
  const topLevelNodes = nodes.value.filter((node) => node.data.level === 0);
  const layoutTopLevelnodes = dagreLayout(topLevelNodes, edges.value, "TB");

  nodes.value = nodes.value.map((node) => {
    const layoutNode = layoutTopLevelnodes.find((n) => n.id === node.id);
    if (layoutNode) {
      node.position = layoutNode.position;
    }
    return node;
  });

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

const resolveEdges = async () => {
  const topLevelObjects = [...objects.value.values()]
    .flat()
    .filter((object) => {
      return !object.metadata.ownerReferences;
    });

  for (const object of topLevelObjects) {
    for (const specLink of specLinks) {
      if (object.kind === specLink.sourceKind) {
        for (const matcher of specLink.matchers) {
          let targetValues = [];
          if (matcher.sourceSelector.startsWith("jsonpath:")) {
            const path = matcher.sourceSelector.replace("jsonpath:", "");
            targetValues = jsonpath.query(object, path);
          } else if (matcher.sourceSelector.startsWith("jsonata:")) {
            const expression = matcher.sourceSelector.replace("jsonata:", "");
            const compiled = jsonata(expression);
            targetValues = (await compiled.evaluate(object)) as [];
          }

          // make them distinct
          targetValues = [...new Set(targetValues)];

          for (const targetValue of targetValues) {
            const targets = objects.value
              .get(specLink.targetKind)
              ?.filter((obj) => {
                if (matcher.targetSelector.startsWith("jsonpath:")) {
                  const path = matcher.targetSelector.replace("jsonpath:", "");
                  let queryResult = jsonpath.query(obj, path);
                  if (matcher.matchType === "exact") {
                    return queryResult == targetValue;
                  } else if (matcher.matchType === "subset") {
                    queryResult = queryResult[0];
                    return Object.keys(targetValue).every((key) => {
                      return queryResult[key] === targetValue[key];
                    });
                  }
                } else if (matcher.targetSelector.startsWith("jsonata:")) {
                  const expression = matcher.targetSelector.replace(
                    "jsonata:",
                    ""
                  );
                  const compiled = jsonata(expression);
                  const queryResult = compiled.evaluate(obj);
                  if (matcher.matchType === "exact") {
                    return queryResult == targetValue;
                  } else if (matcher.matchType === "subset") {
                    return Object.keys(targetValue).every((key) => {
                      return queryResult[key] === targetValue[key];
                    });
                  }
                }
              });

            for (const target of targets || []) {
              edges.value.push({
                id: `${object.metadata.uid}-${target.metadata.uid}`,
                source:
                  specLink.direction === "sourceTarget"
                    ? object.metadata.uid
                    : target.metadata.uid,
                target:
                  specLink.direction === "sourceTarget"
                    ? target.metadata.uid
                    : object.metadata.uid,
                animated: false,
                selectable: false,
                markerEnd: MarkerType.ArrowClosed,
                style: {
                  zIndex: 1000,
                },
              });
            }
          }
        }
      }
    }
  }
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

  //if parent is ReplicaSet, create 1 node with all pods, else just add all
  if (parent.data.kubeObject.kind === "ReplicaSet") {
    const podsNode = {
      id: "pods-" + parent.data.kubeObject.metadata.uid,
      data: {
        label: "Pods",
        kubeObject: children[0],
        pods: children,
        level: level,
      },
      position: { x: 0, y: 0 },
      parentNode: parent.data.kubeObject.metadata.uid || "",
      expandParent: true,
      type: "pods-object",
      class:
        "overflow-hidden bg-background border border-muted rounded text-white nodrag hover:border-white",
    } as Node;

    nodes.value.push(podsNode);
  } else {
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
  }
};

const groupObjectsWithoutEdges = () => {
  const nodesWithoutEdges = nodes.value.filter((node) => {
    return (
      !node.parentNode &&
      edges.value.filter((edge) => edge.source === node.id).length === 0 &&
      edges.value.filter((edge) => edge.target === node.id).length === 0
    );
  });

  if (nodesWithoutEdges.length > 0) {
    const groupNode = {
      id: "unmapped-resources",
      data: {
        label: "",
        kubeObject: { kind: "Unmapped resources" },
        level: 0,
      },
      position: { x: 0, y: 0 },
      type: "kubernetes-object",
      class:
        "overflow-hidden bg-background border border-muted rounded text-white hover:border-white",
    } as Node;

    nodes.value.push(groupNode);

    nodesWithoutEdges.forEach((node) => {
      // update node to be a child of the group node
      node.parentNode = groupNode.id;
      node.data.level = 1;
    });
  }
};

onNodeMouseEnter((event) => {
  const nodeEdges = edges.value.filter(
    (edge) => edge.source === event.node.id || edge.target === event.node.id
  );

  nodeEdges.forEach((edge) => {
    findEdge(edge.id).animated = true;
  });
});

onNodeMouseLeave((event) => {
  const nodeEdges = edges.value.filter(
    (edge) => edge.source === event.node.id || edge.target === event.node.id
  );

  nodeEdges.forEach((edge) => {
    findEdge(edge.id).animated = false;
  });
});

const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);

onNodesChange((nodes) => {
  // show details when a node is clicked
});

const fetchResourceObjects = (resource: V1APIResource): Promise<void> => {
  return new Promise(async (resolve) => {
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

      let items = JSON.parse(result).items;

      /*
       * Filter out resources that cause clutter
       */
      if (resource.kind === "ReplicaSet") {
        items = items.filter((item: V1ReplicaSet) => {
          return item.status?.replicas > 0;
        });
      }

      if (resource.kind === "Secret") {
        items = items.filter((item: V1Secret) => {
          return item.type && !item.type.includes("helm.sh/release");
        });
      }

      if (resource.kind === "PodMetrics") {
        items = [];
      }

      objects.value.set(resource.kind, items);
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

  for (const resource of apiResources.value) {
    fetchResourceObjects(resource).then(async () => {
      if (
        objects.value.size + failedResources.value.length ===
        apiResources.value.length
      ) {
        loadingState.value = "";

        mapObjectsToNodes();
        await resolveEdges();
        groupObjectsWithoutEdges();
        layoutGraph();
      }
    });
  }
};

watch([context, namespace], async () => {
  await refresh();
});

const refresh = async () => {
  apiResources.value = [];
  objects.value = new Map();
  failedResources.value = [];
  nodes.value = [];
  edges.value = [];
  setSidePanelComponent(null);

  await fetchAllResources();
};

onMounted(async () => {
  await refresh();
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
    <VueFlow
      v-else
      :nodes="nodes"
      :edges="edges"
      fit-view-on-init
      @nodes-initialized="layoutTopLevelNodes"
    >
      <template #node-kubernetes-object="props">
        <ObjectNode v-bind="props" />
      </template>
      <template #node-pods-object="props">
        <PodsObjectNode v-bind="props" />
      </template>
    </VueFlow>
  </SpotlightGridContainer>
</template>
<style>
/* import the necessary styles for Vue Flow to work */
@import "@vue-flow/core/dist/style.css";

/* import the default theme, this is optional but generally recommended */
@import "@vue-flow/core/dist/theme-default.css";

.vue-flow__edges.vue-flow__container {
  z-index: 1000 !important;
}

.vue-flow__node-kubernetes-object.selected {
  border-color: #fff;
}
</style>
