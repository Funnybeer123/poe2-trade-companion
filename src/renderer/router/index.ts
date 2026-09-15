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
    redirect: "/home",
  },
  {
    path: "/home",
    name: "home",
    component: () => import("../features/session/views/HomeView.vue"),
    meta: {
      title: "Home",
      eyebrow: "Overview",
      description:
        "Character, session and map activity from Client.txt, stash gains, market movers, and what to set up next.",
    },
  },
  {
    path: "/market",
    name: "market",
    component: () => import("../features/market/views/MarketView.vue"),
    meta: {
      title: "Market",
      eyebrow: "Operate",
      description:
        "Browse trade2 listings, keep favourite searches, run live searches, and whisper sellers — one chat line per click.",
    },
  },
  {
    path: "/trade",
    name: "trade",
    component: () => import("../features/trade/views/TradeView.vue"),
    meta: {
      title: "Trade",
      eyebrow: "Operate",
      description:
        "Offer cards from your whispers, one chat line per click, and the trades the game confirmed.",
    },
  },
  {
    path: "/sort",
    name: "sort",
    component: () => import("../views/SortView.vue"),
    meta: {
      title: "Sort & triage",
      eyebrow: "Operate",
      description:
        "Run the gear sorter, tune the value tiers that pull winners aside, and keep the local price table current.",
    },
  },
  {
    path: "/shop",
    name: "shop",
    component: () => import("../views/ShopView.vue"),
    meta: {
      title: "Shop",
      eyebrow: "Operate",
      description:
        "Manage the public-tab sale listings: scan by Ctrl+C ground truth, reprice stale listings, track realized sales.",
    },
  },
  {
    path: "/wealth",
    name: "wealth",
    component: () => import("../views/WealthView.vue"),
    meta: {
      title: "Wealth",
      eyebrow: "Inspect",
      description:
        "Stash net worth from the sorter's Ctrl+C ledger: what is where, what it is worth, and what to list next.",
    },
  },
  {
    path: "/items",
    name: "items",
    component: () => import("../views/ItemLogView.vue"),
    meta: {
      title: "Item log",
      eyebrow: "Inspect",
      description:
        "Everything the app has seen: evaluated items, the durable catalog, and scan session evidence.",
    },
  },
  {
    path: "/search",
    name: "search",
    component: () => import("../views/SearchView.vue"),
    meta: {
      title: "Search & rules",
      eyebrow: "Define",
      description:
        "Build validated stash queries from an item and author the OR-of-AND rules scans and tiers reuse.",
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
  // Old bookmarks keep working after the navigation merges.
  { path: "/finder", redirect: "/search#finder" },
  { path: "/rules", redirect: "/search#rules" },
  { path: "/scans", redirect: "/items#scans" },
  { path: "/tools/overview", redirect: "/tools" },
  { path: "/tools/opportunity", redirect: "/items" },
  { path: "/tools/qa", redirect: "/tools/diagnostics" },
  { path: "/tools/replay", redirect: "/tools/diagnostics" },
  {
    path: "/tools/:tool?",
    name: "tools",
    component: () => import("../views/ToolsView.vue"),
    meta: {
      title: "Tools & QA",
      eyebrow: "Operate",
      description:
        "Calibration, audited transfers, stash tabs, diagnostics, filters, and settings.",
    },
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/home",
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
