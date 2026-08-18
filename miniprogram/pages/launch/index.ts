/** P01 启动与登录：登录完成后进入首页（文档 3.2 / 7.1）。 */
import { ensureLogin } from "../../services/auth";
import { showApiError } from "../../services/api";

Page({
  data: {
    failed: false,
  },
  onLoad() {
    this.login();
  },
  async login() {
    this.setData({ failed: false });
    try {
      await ensureLogin();
      wx.switchTab({ url: "/pages/home/index" });
    } catch (err) {
      this.setData({ failed: true });
      showApiError(err, "登录失败，请重试");
    }
  },
  onRetry() {
    this.login();
  },
});
