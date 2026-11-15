const { store } = require("./store/index");
const { installAuthRecovery } = require("./services/auth");

App({
  onLaunch() {
    store.restore();
    installAuthRecovery();
  },
});
