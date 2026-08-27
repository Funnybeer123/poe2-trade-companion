import { createApp } from "vue";
import BannerApp from "./BannerApp.vue";
import { resolvePreloadApi } from "./ipc/client.js";
import "./styles.css";

resolvePreloadApi();
createApp(BannerApp).mount("#app");
