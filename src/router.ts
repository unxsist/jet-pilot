import { createRouter, createWebHistory, RouteRecordRaw } from "vue-router";

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
    path: "/cluster-overview",
    name: "ClusterOverview",
    component: () => import("./views/ClusterOverview.vue"),
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
    path: "/helm-:pathMatch(.*)*",
    name: "HelmCharts",
    component: () => import("./views/HelmResource.vue"),
    meta: {
      requiresContext: true,
    },
  },
  {
    path: "/:pathMatch(.*)*",
    name: "GenericResource",
    component: () => import("./views/GenericResource.vue"),
    meta: {
      requiresContext: true,
    },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
