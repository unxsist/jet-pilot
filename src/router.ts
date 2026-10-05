import { createRouter, createWebHistory, RouteRecordRaw } from "vue-router";

const routes: Array<RouteRecordRaw> = [
  {
    path: "/",
    // Same location as the sidebar's Pods link: kept-alive views are keyed
    // by full path, so the start page and the link share one cached view.
    redirect: { path: "/pods", query: { resource: "pods", kind: "Pod" } },
  },
  {
    path: "/settings",
    name: "Settings",
    redirect: { name: "SettingsCategory", params: { category: "general" } },
    component: () => import("./views/Settings.vue"),
    children: [
      {
        // settings.json in the JSON editor.
        path: "json",
        name: "SettingsJson",
        component: () => import("./views/settings/SettingsJson.vue"),
        meta: { fullBleed: true },
      },
      {
        // The JSON theme editor; no id: a new theme.
        path: "appearance/theme/:id?",
        name: "SettingsThemeEditor",
        component: () => import("./views/settings/ThemeEditorRoute.vue"),
        meta: { fullBleed: true },
      },
      // Pages of earlier releases.
      {
        path: "logs",
        redirect: { name: "SettingsCategory", params: { category: "advanced" }, query: { section: "app-log" } },
      },
      {
        path: ":category",
        name: "SettingsCategory",
        component: () => import("./views/settings/SettingsCategory.vue"),
      },
    ],
  },
  {
    path: "/cluster-overview",
    name: "ClusterOverview",
    component: () => import("./views/ClusterOverview.vue"),
    meta: {
      requiresContext: true,
    },
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
