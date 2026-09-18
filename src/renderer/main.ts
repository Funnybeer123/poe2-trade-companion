import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import "./styles.css";
window.poe2?.deck?.onNavigate(route => { void router.push(route); });

createApp(App).use(router).mount("#app");
