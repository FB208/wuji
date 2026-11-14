import { store } from "./store/index";
import { installAuthRecovery } from "./services/auth";

App({
  onLaunch() {
    store.restore();
    installAuthRecovery();
  },
});
