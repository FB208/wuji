import { store } from "./store/index";

App({
  onLaunch() {
    store.restore();
  },
});
