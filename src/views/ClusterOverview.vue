<script setup lang="ts">
import SpotlightGridContainer from "@/components/ui/SpotlightGridContainer.vue";
import type { Node, Edge, NodeSelectionChange } from "@vue-flow/core";
import { MarkerType, VueFlow, useVueFlow } from "@vue-flow/core";
import { useLayout } from "@/composables/useDagreLayout";
import { onMounted } from "vue";
import { injectStrict, formatResourceKind } from "@/lib/utils";
import { error } from "@/lib/logger";
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
import { Button } from "@/components/ui/button";
import specLinks from "@/lib/kubernetesSpecLinks";
import {
  DiscoveredResource,
  buildOwnerIndex,
  dedupeResources,
  mapWithConcurrency,
  qualifiedResourceName,
} from "@/lib/clusterGraph";
import { JSONPath } from "jsonpath-plus";
import jsonata from "jsonata";
import { PanelProviderSetSidePanelComponentKey } from "@/providers/PanelProvider";

/*
 * The overview shows the primary context (the most recently selected one)
 * using that context's kubeconfig, limited to its selected namespaces.
 */
const { context, namespace, kubeConfig, contexts } =
  injectStrict(KubeContextStateKey);

/** Maximum number of concurrent kubectl processes. */
const MAX_CONCURRENT_REQUESTS = 6;

type GraphObject = KubernetesObject & {
  metadata: NonNullable<KubernetesObject["metadata"]>;
};

const apiResources = ref<DiscoveredResource[]>([]);
const failedResources = ref<DiscoveredResource[]>([]);
const completedResources = ref(0);
const loadingState = ref<string>("");
const loadError = ref<string | null>(null);

/* Objects of the current graph, and lookups derived from them. */
let graphObjects: GraphObject[] = [];
let objectsByKind = new Map<string, GraphObject[]>();
let childrenByOwner = new Map<string, GraphObject[]>();

/** Namespaces of the primary context; [] means all namespaces. */
const selectedNamespaces = computed<string[]>(() => {
  const active =
    contexts.value.get(context.value) ||
    (namespace.value ? [namespace.value] : []);
  return active.includes("all") ? [] : active;
});

const scopeLabel = computed(() => {
  const namespaces = selectedNamespaces.value;
  if (namespaces.length === 0) return "All namespaces";
  if (namespaces.length === 1) return namespaces[0];
  return `${namespaces.length} namespaces`;
});

const nodes = ref<Node[]>([]);
const {
  fitView,
  onNodeMouseEnter,
  onNodeMouseLeave,
  findEdge,
  onNodesChange,
  findNode,
  getSelectedNodes,
} = useVueFlow();
const { layout: dagreLayout } = useLayout();

const edges = ref<Edge[]>([]);

const NODE_CLASS =
  "overflow-hidden bg-background border border-foreground-muted rounded text-foreground hover:border-foreground";

const layoutNodes = (
  nodes: Node[],
  padding = { top: 50, left: 25, bottom: 0, right: 25 }
) => {
  const NODE_WIDTH = 150;
  const NODE_HEIGHT = 120;
  const MARGIN = 25;
  const MAX_PER_ROW = 5;

  let nodeMap = new Map<string, Node>();
  let childrenMap = new Map<string, Node[]>();

  nodes.forEach((node) => {
    nodeMap.set(node.id, node);
    if (node.parentNode) {
      if (!childrenMap.has(node.parentNode)) {
        childrenMap.set(node.parentNode, []);
      }
      childrenMap.get(node.parentNode)!.push(node);
    }
  });

  function calculatePositions(nodeId: string) {
    let node = nodeMap.get(nodeId)!;
    let children = childrenMap.get(nodeId) || [];

    let width = NODE_WIDTH;
    let height = NODE_HEIGHT;
    let childPositions: { x: number; y: number; width: number; height: number }[] =
      [];

    if (children.length > 0) {
      let x = padding.left,
        y = padding.top;
      let maxRowWidth = 0;
      let currentRowWidth = 0;
      let rowHeight = 0;
      let totalHeight = padding.top;

      children.forEach((child: Node, index: number) => {
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

    (node.style as Record<string, string>).width = `${width}px`;
    (node.style as Record<string, string>).height = `${height}px`;

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
    const layoutNode = layoutTopLevelnodes.find((n: Node) => n.id === node.id);
    if (layoutNode) {
      node.position = layoutNode.position;
    }
    return node;
  });

  nextTick(() => {
    fitView();
  });
};

const topLevelObjects = () =>
  graphObjects.filter((object) => !object.metadata.ownerReferences);

const mapObjectsToNodes = () => {
  nodes.value.push(
    ...topLevelObjects().map((object): Node => {
      return {
        id: object.metadata.uid || object.metadata.name || "",
        data: { label: object.metadata.name, kubeObject: object, level: 0 },
        position: { x: 0, y: 0 },
        type: "kubernetes-object",
        class: NODE_CLASS,
      };
    })
  );

  [...nodes.value].forEach((node) => {
    resolveChildNodesForParent(node, 1);
  });
};

/* jsonata expressions are compiled once per selector. */
const compiledExpressions = new Map<string, ReturnType<typeof jsonata>>();
const compileExpression = (expression: string) => {
  let compiled = compiledExpressions.get(expression);
  if (!compiled) {
    compiled = jsonata(expression);
    compiledExpressions.set(expression, compiled);
  }
  return compiled;
};

const evaluateSelector = async (
  selector: string,
  object: object
): Promise<any> => {
  if (selector.startsWith("jsonpath:")) {
    return JSONPath({
      path: selector.replace("jsonpath:", ""),
      json: object,
      wrap: true,
    });
  }
  if (selector.startsWith("jsonata:")) {
    return compileExpression(selector.replace("jsonata:", "")).evaluate(
      object
    );
  }
  return undefined;
};

const matchesTarget = (
  queryResult: any,
  targetValue: any,
  matchType: "exact" | "subset",
  isJsonPath: boolean
) => {
  if (matchType === "exact") {
    return queryResult == targetValue;
  }

  const subject = isJsonPath ? queryResult?.[0] : queryResult;
  if (subject == null || targetValue == null) {
    return false;
  }
  return Object.keys(targetValue).every(
    (key) => subject[key] === targetValue[key]
  );
};

const resolveEdges = async () => {
  // Target selector results per (selector, object): evaluated at most once.
  const targetResults = new Map<string, Map<GraphObject, any>>();
  const evaluateTarget = async (selector: string, object: GraphObject) => {
    let results = targetResults.get(selector);
    if (!results) {
      results = new Map();
      targetResults.set(selector, results);
    }
    if (!results.has(object)) {
      results.set(object, await evaluateSelector(selector, object));
    }
    return results.get(object);
  };

  for (const object of topLevelObjects()) {
    for (const specLink of specLinks) {
      if (object.kind !== specLink.sourceKind) {
        continue;
      }

      for (const matcher of specLink.matchers) {
        let targetValues: any[] = [];
        try {
          targetValues = (await evaluateSelector(
            matcher.sourceSelector,
            object
          )) as any[];
        } catch (e) {
          error(`Failed to evaluate ${matcher.sourceSelector}: ${e}`);
          continue;
        }

        // make them distinct
        targetValues = [...new Set(targetValues || [])];

        const candidates = objectsByKind.get(specLink.targetKind) || [];
        for (const targetValue of targetValues) {
          for (const target of candidates) {
            let queryResult;
            try {
              queryResult = await evaluateTarget(
                matcher.targetSelector,
                target
              );
            } catch (e) {
              continue;
            }

            if (
              !matchesTarget(
                queryResult,
                targetValue,
                matcher.matchType,
                matcher.targetSelector.startsWith("jsonpath:")
              )
            ) {
              continue;
            }

            const objectUid = object.metadata.uid || "";
            const targetUid = target.metadata.uid || "";
            edges.value.push({
              id: `${objectUid}-${targetUid}`,
              source:
                specLink.direction === "sourceTarget" ? objectUid : targetUid,
              target:
                specLink.direction === "sourceTarget" ? targetUid : objectUid,
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
};

const resolveChildNodesForParent = (parent: Node, level: number) => {
  const parentUid = parent.data.kubeObject.metadata?.uid;
  const children = parentUid ? childrenByOwner.get(parentUid) || [] : [];

  if (children.length === 0) {
    return;
  }

  //if parent is ReplicaSet, create 1 node with all pods, else just add all
  if (parent.data.kubeObject.kind === "ReplicaSet") {
    const podsNode = {
      id: "pods-" + parentUid,
      data: {
        label: "Pods",
        kubeObject: children[0],
        pods: children,
        level: level,
      },
      position: { x: 0, y: 0 },
      parentNode: parentUid || "",
      expandParent: true,
      type: "pods-object",
      class: `${NODE_CLASS} nodrag`,
    } as Node;

    nodes.value.push(podsNode);
  } else {
    children.forEach((child) => {
      // An object with several owners is shown under the first one only.
      if (child.metadata.ownerReferences?.[0]?.uid !== parentUid) {
        return;
      }

      const node = {
        id: child.metadata.uid || child.metadata.name,
        data: { label: child.metadata.name, kubeObject: child, level: level },
        position: { x: 0, y: 0 },
        parentNode: parentUid || "",
        expandParent: true,
        type: "kubernetes-object",
        class: `${NODE_CLASS} nodrag`,
      } as Node;

      nodes.value.push(node);

      resolveChildNodesForParent(node, level + 1);
    });
  }
};

const groupObjectsWithoutEdges = () => {
  const connected = new Set<string>();
  edges.value.forEach((edge) => {
    connected.add(edge.source);
    connected.add(edge.target);
  });

  const nodesWithoutEdges = nodes.value.filter((node) => {
    return !node.parentNode && !connected.has(node.id);
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
      class: NODE_CLASS,
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
    const found = findEdge(edge.id);
    if (found) found.animated = true;
  });
});

onNodeMouseLeave((event) => {
  const node = findNode(event.node.id);

  if (node && node.selected) {
    return;
  }

  const selectedNodeIds = getSelectedNodes.value.map((node) => node.id);

  const nodeEdges = edges.value.filter(
    (edge) =>
      (edge.source === event.node.id || edge.target === event.node.id) &&
      !selectedNodeIds.includes(edge.source) &&
      !selectedNodeIds.includes(edge.target)
  );

  nodeEdges.forEach((edge) => {
    const found = findEdge(edge.id);
    if (found) found.animated = false;
  });
});

const setSidePanelComponent = injectStrict(
  PanelProviderSetSidePanelComponentKey
);

const ResourcePanel = defineAsyncComponent(
  () => import("@/views/panels/Resource.vue")
);

onNodesChange((nodeChanges) => {
  if (
    nodeChanges.filter((node) => node.type === "select" && node.selected)
      .length === 1
  ) {
    const selectedNode = nodeChanges.find(
      (node) => node.type === "select" && node.selected
    ) as NodeSelectionChange;
    if (selectedNode) {
      const node = findNode(selectedNode.id);

      if (!node || node.id === "unmapped-resources") {
        setSidePanelComponent(null);
        return;
      }

      const kubeObject = node.data.kubeObject;

      setSidePanelComponent({
        title: `${kubeObject.kind}: ${kubeObject.metadata?.name}` || "Resource",
        icon: formatResourceKind(kubeObject.kind).toLowerCase(),
        component: ResourcePanel,
        props: {
          resource: kubeObject,
        },
      });
    }
  } else {
    setSidePanelComponent(null);
  }

  nodeChanges.forEach((nodeChange) => {
    if (nodeChange.type !== "select") {
      return;
    }

    const nodeEdges = edges.value.filter(
      (edge) => edge.source === nodeChange.id || edge.target === nodeChange.id
    );
    nodeEdges.forEach((edge) => {
      const found = findEdge(edge.id);
      if (found) found.animated = nodeChange.selected;
    });
  });
});

const isListedResource = (resource: V1APIResource) =>
  !resource.name.includes("/") &&
  resource.namespaced &&
  resource.name !== "events" &&
  // Metrics are not objects worth graphing.
  resource.kind !== "PodMetrics";

/*
 * Namespaced API resources of the cluster, keyed by group + resource so
 * equally named kinds of different API groups are all kept.
 */
const discoverResources = async (
  discoveryContext: string,
  discoveryKubeConfig: string
): Promise<DiscoveredResource[]> => {
  const resources: DiscoveredResource[] = [];

  const versions = await Kubernetes.getCoreApiVersions(
    discoveryContext,
    discoveryKubeConfig
  );
  for (const version of versions) {
    const coreResources = await Kubernetes.getCoreApiResources(
      discoveryContext,
      version,
      discoveryKubeConfig
    );
    resources.push(
      ...coreResources
        .filter(isListedResource)
        .map((r) => ({ name: r.name, group: "", kind: r.kind }))
    );
  }

  const groups = await Kubernetes.getApiGroups(
    discoveryContext,
    discoveryKubeConfig
  );
  const groupResources = await mapWithConcurrency(
    groups,
    MAX_CONCURRENT_REQUESTS,
    (group) =>
      Kubernetes.getApiGroupResources(
        discoveryContext,
        group.preferredVersion?.groupVersion || "",
        discoveryKubeConfig
      )
  );

  groupResources.forEach((result, i) => {
    if (result.status === "rejected") {
      error(
        `Error fetching resources for group ${groups[i].name}: ${result.reason}`
      );
      return;
    }

    resources.push(
      ...result.value
        .filter(isListedResource)
        .map((r) => ({ name: r.name, group: groups[i].name, kind: r.kind }))
    );
  });

  return dedupeResources(resources);
};

const fetchResourceObjects = async (
  resource: DiscoveredResource,
  fetchContext: string,
  fetchKubeConfig: string,
  namespaces: string[]
): Promise<GraphObject[]> => {
  const args = [
    "get",
    qualifiedResourceName(resource),
    "--context",
    fetchContext,
    "-o",
    "json",
    "--request-timeout=30s",
  ];

  if (fetchKubeConfig) {
    args.push("--kubeconfig", fetchKubeConfig);
  }

  if (namespaces.length === 1) {
    args.push("--namespace", namespaces[0]);
  } else {
    args.push("--all-namespaces");
  }

  let items: GraphObject[] = JSON.parse(await Kubernetes.kubectl(args)).items;
  items = (items || []).filter((item) => item.metadata);

  if (namespaces.length > 1) {
    items = items.filter((item) =>
      namespaces.includes(item.metadata.namespace || "")
    );
  }

  /*
   * Filter out resources that cause clutter
   */
  if (resource.kind === "ReplicaSet") {
    items = items.filter((item) => {
      return ((item as V1ReplicaSet).status?.replicas ?? 0) > 0;
    });
  }

  if (resource.kind === "Secret") {
    items = items.filter((item) => {
      const type = (item as V1Secret).type;
      return type && !type.includes("helm.sh/release");
    });
  }

  // Tag objects with their origin so panel actions target the right cluster.
  return items.map((item) => ({
    ...item,
    metadata: {
      ...item.metadata,
      context: fetchContext,
      kubeConfig: fetchKubeConfig,
    },
  }));
};

/*
 * Each refresh gets a generation: results of an earlier refresh (e.g. for
 * the previously selected context) are dropped instead of being mixed in.
 */
let refreshGeneration = 0;

const refresh = async () => {
  const generation = ++refreshGeneration;
  const isCurrent = () => generation === refreshGeneration;

  apiResources.value = [];
  failedResources.value = [];
  completedResources.value = 0;
  loadError.value = null;
  graphObjects = [];
  objectsByKind = new Map();
  childrenByOwner = new Map();
  nodes.value = [];
  edges.value = [];
  setSidePanelComponent(null);

  const fetchContext = context.value;
  const fetchKubeConfig = kubeConfig.value;
  const namespaces = [...selectedNamespaces.value];

  if (!fetchContext) {
    loadingState.value = "";
    return;
  }

  try {
    loadingState.value = "Discovering resources...";
    const resources = await discoverResources(fetchContext, fetchKubeConfig);
    if (!isCurrent()) return;

    apiResources.value = resources;
    loadingState.value = "Fetching resources...";

    const results = await mapWithConcurrency(
      resources,
      MAX_CONCURRENT_REQUESTS,
      async (resource) => {
        try {
          return await fetchResourceObjects(
            resource,
            fetchContext,
            fetchKubeConfig,
            namespaces
          );
        } finally {
          if (isCurrent()) completedResources.value++;
        }
      }
    );
    if (!isCurrent()) return;

    const seenUids = new Set<string>();
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        failedResources.value.push(resources[i]);
        error(
          `Failed to fetch ${qualifiedResourceName(resources[i])}: ${
            result.reason
          }`
        );
        return;
      }

      // A resource can be served by several groups (e.g. legacy aliases).
      for (const object of result.value) {
        const uid = object.metadata.uid;
        if (uid) {
          if (seenUids.has(uid)) continue;
          seenUids.add(uid);
        }
        graphObjects.push(object);
      }
    });

    if (resources.length > 0 && failedResources.value.length === resources.length) {
      throw new Error("Failed to fetch any resources of this cluster");
    }

    for (const object of graphObjects) {
      const kind = object.kind || "";
      objectsByKind.set(kind, [...(objectsByKind.get(kind) || []), object]);
    }
    childrenByOwner = buildOwnerIndex(graphObjects);

    mapObjectsToNodes();
    await resolveEdges();
    if (!isCurrent()) return;
    groupObjectsWithoutEdges();
    layoutGraph();
    loadingState.value = "";
  } catch (e) {
    if (!isCurrent()) return;
    error(`Failed to load the cluster overview: ${e}`);
    loadError.value = e instanceof Error ? e.message : String(e);
    loadingState.value = "";
  }
};

watch(
  () => [context.value, kubeConfig.value, selectedNamespaces.value.join("\n")],
  async () => {
    await refresh();
  }
);

onMounted(async () => {
  await refresh();
});
</script>
<template>
  <SpotlightGridContainer>
    <div
      class="absolute top-2 left-2 z-10 flex items-center gap-2 rounded-md border bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm"
    >
      <span class="font-semibold text-foreground">{{ context }}</span>
      <span>·</span>
      <span>{{ scopeLabel }}</span>
      <span
        v-if="failedResources.length > 0 && !loadError"
        class="text-destructive"
        :title="failedResources.map(qualifiedResourceName).join(', ')"
      >
        · {{ failedResources.length }} resource type{{
          failedResources.length === 1 ? "" : "s"
        }}
        failed to load
      </span>
    </div>
    <div
      v-if="loadError"
      role="alert"
      class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center"
    >
      <span class="font-semibold text-destructive">
        Failed to load the resource graph
      </span>
      <pre
        class="max-w-xl whitespace-pre-wrap break-words text-xs text-muted-foreground select-text"
        >{{ loadError }}</pre
      >
      <Button variant="secondary" size="xs" @click="refresh">Retry</Button>
    </div>
    <div
      v-else-if="loadingState !== ''"
      class="absolute top-0 left-0 bottom-0 right-0 flex items-center justify-center backdrop-blur-sm"
    >
      {{ loadingState }}
      <span class="ml-2" v-if="apiResources.length > 0"
        >({{ completedResources }}/{{ apiResources.length }})</span
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

.vue-flow__node-kubernetes-object.selected,
.vue-flow__node-pods-object.selected {
  border-color: hsl(var(--foreground));
}
</style>
