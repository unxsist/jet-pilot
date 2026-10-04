import type { Component } from "vue";
import {
  Activity,
  AppWindow,
  Archive,
  BadgeCheck,
  Box,
  Boxes,
  CalendarClock,
  Copy,
  Database,
  Disc,
  FileCode2,
  FileCog,
  FileText,
  FolderTree,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Layers3,
  Link,
  ListChecks,
  MoveVertical,
  Network,
  Plug,
  Puzzle,
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

  // Common CRDs
  certificates: BadgeCheck,
  certificaterequests: BadgeCheck,
  issuers: Stamp,
  clusterissuers: Stamp,

  // App surfaces
  helm: Ship,
  diagram: Workflow,
  settings: Settings,
  tab: AppWindow,
  edit: FileCode2,
  describe: FileText,
  logs: ScrollText,
  shell: SquareTerminal,
};

/** Lucide icon for a resource / surface name; a neutral shape otherwise. */
export function kindIcon(name: string | undefined | null): Component {
  return (name && ICONS[name.toLowerCase()]) || Shapes;
}
