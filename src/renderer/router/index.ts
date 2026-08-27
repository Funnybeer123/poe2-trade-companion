import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router";

declare module "vue-router" {
  interface RouteMeta {
    title: string;
    eyebrow: string;
    description: string;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    redirect: "/items",
  },
  {
    path: "/items",
    name: "items",
    component: () => import("../views/ItemsView.vue"),
    meta: {
      title: "Item intelligence",
      eyebrow: "Inspect",
      description:
        "Parse copied items, review explainable estimates, and manage the durable local catalog.",
    },
  },
  {
    path: "/finder",
    name: "finder",
    component: () => import("../views/FinderView.vue"),
    meta: {
      title: "Stash query finder",
      eyebrow: "Search",
      description:
        "Turn item fields and modifiers into validated, non-truncated stash queries.",
    },
  },
  {
    path: "/builds",
    name: "builds",
    component: () => import("../views/BuildsView.vue"),
    meta: {
      title: "Build profiles",
      eyebrow: "Plan",
      description:
        "Import local trade targets, edit upgrade rules, and measure catalog coverage.",
    },
  },
  {
    path: "/rules",
    name: "rules",
    component: () => import("../views/RulesView.vue"),
    meta: {
      title: "Rule studio",
      eyebrow: "Define",
      description:
        "Author safe OR-of-AND match rules with inline validation and AST feedback.",
    },
  },
  {
    path: "/scans",
    name: "scans",
    component: () => import("../views/ScansView.vue"),
    meta: {
      title: "Scan sessions",
      eyebrow: "Review",
      description:
        "Inspect offline session outcomes, slot evidence, and timeout or miss states.",
    },
  },
  {
    path: "/tools/:tool?",
    name: "tools",
    component: () => import("../views/ToolsView.vue"),
    meta: {
      title: "Tools & QA",
      eyebrow: "Operate",
      description:
        "Calibration, audited transfers, replay, filters, diagnostics, and settings.",
    },
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/items",
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.afterEach((route) => {
  document.title = `${route.meta.title} · PoE2 Intelligence`;
});
