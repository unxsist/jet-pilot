import { createRouter, createWebHistory, RouteRecordRaw } from "vue-router";

const routes: Array<RouteRecordRaw> = [
  {
    path: "/",
    name: "Pods",
    component: () => import("./views/Pods.vue"),
  },
  {
    path: "/deployments",
    name: "Deployments",
    component: () => import("./views/Deployments.vue"),
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
