import { createApp } from "vue";
import App from "./App.vue";
import { resolvePreloadApi } from "./ipc/client.js";
import { router } from "./router.js";
import "./styles.css";

resolvePreloadApi();
createApp(App).use(router).mount("#app");
