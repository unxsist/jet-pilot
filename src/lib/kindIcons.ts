import { shallowRef, type Component } from "vue";
import {
  Activity,
  AppWindow,
  Archive,
  BadgeCheck,
  Box,
  Boxes,
  Bug,
  CalendarClock,
  Cloud,
  Copy,
  Database,
  Disc,
  FileCode2,
  FileCog,
  FileStack,
  FileText,
  FolderTree,
  Gauge,
  GitBranch,
  GitMerge,
  GitCompareArrows,
  Globe,
  HardDrive,
  History,
  KeyRound,
  Layers3,
  Link,
  ListChecks,
  MoveVertical,
  Network,
  Package,
  Plug,
  Puzzle,
  Rocket,
  Route,
  Router,
  Ruler,
  Scaling,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  Shapes,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  Ship,
  SquareTerminal,
  Stamp,
  UserCog,
  Waypoints,
  Workflow,
} from "lucide-vue-next";

/*
 * One consistent (lucide) icon per Kubernetes kind / app surface. Keys are
 * the lower-cased plural resource names used throughout the app
 * (`formatResourceKind(kind).toLowerCase()`) plus a few app icon names
 * (tab types, navigation links).
 */
const ICONS: Record<string, Component> = {
  // Workloads
  pods: Box,
  deployments: Layers3,
  replicasets: Copy,
  replicationcontrollers: Copy,
  statefulsets: Database,
  daemonsets: ServerCog,
  jobs: ListChecks,
  cronjobs: CalendarClock,

  // Cluster
  nodes: Server,
  namespaces: FolderTree,
  events: Activity,
  customresourcedefinitions: Puzzle,
  "unmapped resources": Boxes,

  // Network
  services: Network,
  endpoints: Waypoints,
  endpointslices: Waypoints,
  ingresses: Globe,
  ingressclasses: Router,
  networkpolicies: ShieldHalf,
  virtualservices: Route,
  gateways: Router,
  httproutes: Route,

  // Config & storage
  configmaps: FileCog,
  secrets: KeyRound,
  resourcequotas: Gauge,
  limitranges: Ruler,
  persistentvolumes: HardDrive,
  persistentvolumeclaims: Archive,
  storageclasses: Disc,
  csidrivers: Plug,
  csinodes: Plug,
  volumeattachments: Plug,

  // Scaling & policy
  horizontalpodautoscalers: Scaling,
  verticalpodautoscalers: MoveVertical,
  poddisruptionbudgets: ShieldAlert,

  // Access control
  serviceaccounts: UserCog,
  roles: Shield,
  clusterroles: Shield,
  rolebindings: Link,
  clusterrolebindings: Link,
  accessreview: ShieldCheck,

  // Common CRDs (more in ./operatorIcons)
  certificates: BadgeCheck,
  certificaterequests: BadgeCheck,
  issuers: Stamp,
  clusterissuers: Stamp,

  // GitOps (Flux, Argo CD)
  kustomizations: FileStack,
  helmreleases: Ship,
  gitrepositories: GitBranch,
  ocirepositories: Package,
  helmrepositories: Package,
  helmcharts: Package,
  buckets: Archive,
  applications: Rocket,
  applicationsets: Boxes,

  // App surfaces
  helm: Ship,
  releases: Ship,
  "helm-charts": Package,
  diagram: Workflow,
  gitops: GitMerge,
  clustershub: Cloud,
  health: Activity,
  clusters: Cloud,
  settings: Settings,
  tab: AppWindow,
  edit: FileCode2,
  describe: FileText,
  diff: GitCompareArrows,
  logs: ScrollText,
  shell: SquareTerminal,
  history: History,
  debug: Bug,
};

/*
 * Icons of operator kinds (cert-manager, Karpenter, KEDA, ...) stay out of
 * the startup bundle: they load the first time a kind without an icon here
 * is drawn, and icons drawn meanwhile update (reactive).
 */
const operatorIcons = shallowRef<Record<string, Component> | null>(null);
let operatorIconsRequested = false;
const loadOperatorIcons = () => {
  if (operatorIconsRequested) return;
  operatorIconsRequested = true;
  import("./operatorIcons").then(({ OPERATOR_ICONS }) => (operatorIcons.value = OPERATOR_ICONS));
};

/** Lucide icon for a resource / surface name; a neutral shape otherwise. */
export function kindIcon(name: string | undefined | null): Component {
  if (!name) return Shapes;
  const key = name.toLowerCase();
  // Some callers pass the singular kind ("pod"); `plural.group` names pick
  // one group's icon (CloudNativePG's clusters), else the plural's.
  const plural = key.split(".")[0];
  const own = ICONS[key] || ICONS[`${key}s`];
  if (own) return own;
  const extra = operatorIcons.value;
  if (!extra) loadOperatorIcons();
  return extra?.[key] || extra?.[plural] || ICONS[plural] || Shapes;
}
