import { createApp } from "vue";
import App from "./App.vue";
import OverlayApp from "./overlay/OverlayApp.vue";
import { router } from "./router";
import "./styles.css";

// The transparent overlay window (src/main/overlayWindow.ts) loads this same
// bundle at "#/overlay": it gets the panel host instead of the app shell, and
// no router — panels are driven by main through "overlay:panel" events.
if (window.location.hash.startsWith("#/overlay")) {
  document.documentElement.classList.add("overlay-mode");
  createApp(OverlayApp).mount("#app");
} else {
  createApp(App).use(router).mount("#app");
}
