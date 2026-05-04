import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  // Make sure component exceptions surface in the console instead of
  // freezing the UI silently.
  console.error(`[saivage] vue error in ${info}:`, err);
};
app.mount("#app");
