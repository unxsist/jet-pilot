export interface SpecLink {
  direction: "targetSource" | "sourceTarget";
  sourceKind: string;
  targetKind: string;
  matchers: SpecLinkMatcher[];
}

export interface SpecLinkMatch {
  sourceSelector: string;
  targetSelector: string;
  matchType: "exact" | "subset";
}

const specLinks: SpecLink[] = [
  {
    direction: "sourceTarget",
    sourceKind: "PodDisruptionBudget",
    targetKind: "Deployment",
    matchers: [
      {
        sourceSelector: "jsonpath:$.spec.selector.matchLabels",
        targetSelector: "jsonpath:$.spec.template.metadata.labels",
        matchType: "subset",
      },
    ],
  },
  {
    direction: "sourceTarget",
    sourceKind: "Service",
    targetKind: "Deployment",
    matchers: [
      {
        sourceSelector: "jsonpath:$.spec.selector",
        targetSelector: "jsonpath:$.spec.template.metadata.labels",
        matchType: "subset",
      },
    ],
  },
  {
    direction: "sourceTarget",
    sourceKind: "ConfigMap",
    targetKind: "Deployment",
    matchers: [
      {
        sourceSelector: "jsonpath:$.metadata.name",
        targetSelector:
          "jsonpath:$.spec.template.spec.volumes.*.configMap.name",
        matchType: "exact",
      },
    ],
  },
  {
    direction: "sourceTarget",
    sourceKind: "ServiceAccount",
    targetKind: "Deployment",
    matchers: [
      {
        sourceSelector: "jsonpath:$.metadata.name",
        targetSelector: "jsonpath:$.spec.template.spec.serviceAccountName",
        matchType: "exact",
      },
    ],
  },
  {
    direction: "sourceTarget",
    sourceKind: "Secret",
    targetKind: "Deployment",
    matchers: [
      {
        sourceSelector: "jsonpath:$.metadata.name",
        targetSelector:
          "jsonpath:$.spec.template.spec.containers.*.env.*.valueFrom.secretKeyRef.name",
        matchType: "exact",
      },
      {
        sourceSelector: "jsonpath:$.metadata.name",
        targetSelector:
          "jsonpath:$.spec.template.spec.containers.*.envFrom.*.secretRef.name",
        matchType: "exact",
      },
      {
        sourceSelector: "jsonpath:$.metadata.name",
        targetSelector:
          "jsonpath:$.spec.template.spec.volumes.*.secret.secretName",
        matchType: "exact",
      },
    ],
  },
  {
    direction: "sourceTarget",
    sourceKind: "HorizontalPodAutoscaler",
    targetKind: "Deployment",
    matchers: [
      {
        sourceSelector:
          "jsonata:[$.spec.scaleTargetRef[kind = 'Deployment'].name]",
        targetSelector: "jsonpath:$.metadata.name",
        matchType: "exact",
      },
    ],
  },
  {
    direction: "sourceTarget",
    sourceKind: "Endpoints",
    targetKind: "Service",
    matchers: [
      {
        sourceSelector: "jsonpath:$.metadata.name",
        targetSelector: "jsonpath:$.metadata.name",
        matchType: "exact",
      },
    ],
  },
  {
    direction: "sourceTarget",
    sourceKind: "VirtualService",
    targetKind: "Service",
    matchers: [
      {
        sourceSelector:
          'jsonata:[$.spec.http.route.destination.host ~> function($host) {$map($host, function($h) {$match($h, /cluster\\.local/) ? $split($h, ".")[0] : $h})}]',
        targetSelector: "jsonpath:$.metadata.name",
        matchType: "exact",
      },
    ],
  },
];

export default specLinks;
