import { createRouter, createWebHashHistory } from "vue-router";
import PriceCheckView from "./views/PriceCheckView.vue";
import CatalogView from "./views/CatalogView.vue";
import AutomationDashboard from "./views/AutomationDashboard.vue";
import PerceptionDebugView from "./views/PerceptionDebugView.vue";
import TraceReplayView from "./views/TraceReplayView.vue";
import ScenarioEditorView from "./views/ScenarioEditorView.vue";
import SettingsView from "./views/SettingsView.vue";
import FilterBuilderView from "./views/FilterBuilderView.vue";
import DisclaimerView from "./views/DisclaimerView.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/price-check" },
    { path: "/price-check", name: "price-check", component: PriceCheckView },
    { path: "/catalog", name: "catalog", component: CatalogView },
    { path: "/automation", name: "automation", component: AutomationDashboard },
    { path: "/perception", name: "perception", component: PerceptionDebugView },
    { path: "/replay", name: "replay", component: TraceReplayView },
    { path: "/scenarios", name: "scenarios", component: ScenarioEditorView },
    { path: "/settings", name: "settings", component: SettingsView },
    { path: "/filters", name: "filters", component: FilterBuilderView },
    { path: "/disclaimer", name: "disclaimer", component: DisclaimerView },
  ],
});
