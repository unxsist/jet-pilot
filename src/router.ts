import { createRouter, createWebHistory, RouteRecordRaw } from "vue-router";
import ColumnDefinitions from "@/components/tables/ColumnDefinitions";

const routes: Array<RouteRecordRaw> = [
  {
    path: "/",
    redirect: "/pods",
  },
  {
    path: "/settings",
    name: "Settings",
    redirect: "/settings/general",
    component: () => import("./views/Settings.vue"),
    children: [
      {
        path: "general",
        name: "SettingsGeneral",
        component: () => import("./views/settings/General.vue"),
      },
      {
        path: "appearance",
        name: "SettingsAppearance",
        component: () => import("./views/settings/Appearance.vue"),
      },
      {
        path: "clusters",
        name: "SettingsClusters",
        component: () => import("./views/settings/Clusters.vue"),
      },
      {
        path: "logs",
        name: "SettingsLogs", 
        component: () => import("./views/settings/Logs.vue"),
      },
    ],
  },
  {
    path: "/pods",
    name: "Pods",
    component: () => import("./views/Pods.vue"),
    meta: {
      requiresContext: true,
    },
  },
  {
    path: "/deployments",
    name: "Deployments",
    component: () => import("./views/Deployments.vue"),
  },
  {
    path: "/jobs",
    name: "Jobs",
    component: () => import("./views/Jobs.vue"),
  },
  {
    path: "/cronjobs",
    name: "CronJobs",
    component: () => import("./views/CronJobs.vue"),
  },
  {
    path: "/configmaps",
    name: "ConfigMaps",
    component: () => import("./views/ConfigMaps.vue"),
  },
  {
    path: "/secrets",
    name: "Secrets",
    component: () => import("./views/Secrets.vue"),
  },
  {
    path: "/services",
    name: "Services",
    component: () => import("./views/Services.vue"),
  },
  {
    path: "/virtualservices",
    name: "VirtualServices",
    component: () => import("./views/GenericResource.vue"),
    props: {
      columns: ColumnDefinitions.VirtualServices,
    },
  },
  {
    path: "/ingresses",
    name: "Ingresses",
    component: () => import("./views/Ingresses.vue"),
  },
  {
    path: "/persistentvolumeclaims",
    name: "PersistentVolumeClaims",
    component: () => import("./views/PersistentVolumeClaims.vue"),
  },
  {
    path: "/helm-:pathMatch(.*)*",
    name: "HelmCharts",
    component: () => import("./views/HelmResource.vue"),
  },
  {
    path: "/:pathMatch(.*)*",
    name: "GenericResource",
    component: () => import("./views/GenericResource.vue"),
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
