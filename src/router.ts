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
        path: "contexts",
        name: "SettingsContexts",
        component: () => import("./views/settings/Contexts.vue"),
      },
    ],
  },
  {
    path: "/pods",
    name: "Pods",
    component: () => import("./views/Pods.vue"),
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
    component: () => import("./views/VirtualServices.vue"),
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
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
