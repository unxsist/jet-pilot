import type { Component } from "vue";
import {
  ArchiveRestore,
  BellRing,
  CalendarClock,
  CloudCog,
  Cpu,
  Database,
  DatabaseBackup,
  Fingerprint,
  Flame,
  Globe,
  HardDrive,
  KeyRound,
  KeySquare,
  Layers2,
  ListChecks,
  Radar,
  ReceiptText,
  Route,
  Router,
  ShieldCheck,
  ShieldQuestion,
  Signpost,
  Siren,
  Upload,
  Vault,
  Waypoints,
  Zap,
} from "lucide-vue-next";

/*
 * Icons of operator kinds (see @/lib/apiGroups), loaded lazily by
 * ./kindIcons. Keys are lower-cased plurals, or `plural.group` where a
 * plural means different things (CloudNativePG's clusters).
 */
export const OPERATOR_ICONS: Record<string, Component> = {
  // cert-manager (certificates and issuers are in ./kindIcons)
  orders: ReceiptText,
  challenges: ShieldQuestion,

  // Gateway API
  gatewayclasses: Router,
  grpcroutes: Route,
  tlsroutes: Route,
  tcproutes: Route,

  // Karpenter
  nodepools: Layers2,
  nodeclaims: Cpu,
  ec2nodeclasses: CloudCog,

  // KEDA
  scaledobjects: Zap,
  scaledjobs: ListChecks,
  triggerauthentications: KeyRound,
  clustertriggerauthentications: KeyRound,

  // External Secrets
  externalsecrets: KeySquare,
  clusterexternalsecrets: KeySquare,
  secretstores: Vault,
  clustersecretstores: Vault,
  pushsecrets: Upload,

  // Prometheus Operator
  servicemonitors: Radar,
  podmonitors: Radar,
  probes: Radar,
  prometheusrules: Siren,
  prometheuses: Flame,
  alertmanagers: BellRing,
  alertmanagerconfigs: BellRing,

  // Velero, CloudNativePG
  backups: DatabaseBackup,
  restores: ArchiveRestore,
  schedules: CalendarClock,
  scheduledbackups: CalendarClock,
  backupstoragelocations: HardDrive,
  "clusters.postgresql.cnpg.io": Database,
  poolers: Waypoints,

  // Istio
  destinationrules: Signpost,
  serviceentries: Globe,
  authorizationpolicies: ShieldCheck,
  peerauthentications: Fingerprint,
};
