/** 编辑账号资料；微信头像选择暂时隐藏页面时保留草稿。 */
const { request, uploadFile, ApiError } = require("../../services/api");
const { ensureLogin, applyProfile } = require("../../services/auth");
const { store } = require("../../store/index");

Page({
  data: { nickname: "", avatarUrl: "", ready: false, saving: false },

  /** 首次进入读取资料，后续显示不覆盖用户输入。 */
  async onLoad() {
    this._alive = true;
    this._avatarPath = "";
    try {
      await ensureLogin();
      if (!this._alive) return;
      this._scope = store.captureScope();
      this.setData({
        nickname: store.user.nickname || "",
        avatarUrl: store.user.avatar_url || "",
        ready: true,
      });
    } catch (err) {
      if (this._alive) wx.showToast({ title: err.message || "加载失败", icon: "none" });
    }
  },

  /** 离开编辑页后阻止请求回写页面。 */
  onUnload() {
    this._alive = false;
    if (this._task) this._task.abort();
  },

  /** 只预览本地头像，保存时才上传。 */
  onChooseAvatar(event) {
    if (this.data.saving || !this.data.ready) return;
    const path = event.detail.avatarUrl;
    if (!path) return;
    this._avatarPath = path;
    this.setData({ avatarUrl: path });
  },

  /** 使用表单最终值提交昵称和可选头像，成功后同步全局资料。 */
  async onSave(event) {
    if (!this.data.ready || this.data.saving) return;
    if (!store.isCurrentScope(this._scope)) {
      wx.showToast({ title: "登录或家庭已变化，请重新进入", icon: "none" });
      return;
    }
    const nickname = (event.detail.value.nickname || "").trim();
    if (Array.from(nickname).length < 1 || Array.from(nickname).length > 32) {
      wx.showToast({ title: "昵称须为 1～32 个字符", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    const isCancelled = () => !this._alive || !store.isCurrentScope(this._scope);
    const options = { isCancelled, onTask: (task) => { this._task = task; } };
    try {
      const user = this._avatarPath
        ? await uploadFile({
          ...options, path: "/me/profile/avatar", filePath: this._avatarPath,
          name: "avatar", formData: { nickname },
        })
        : await request({ ...options, path: "/me/profile", method: "POST", data: { nickname } });
      if (isCancelled()) return;
      applyProfile(user);
      wx.navigateBack();
      wx.showToast({ title: "已保存", icon: "success" });
    } catch (err) {
      if (isCancelled()) return;
      wx.showToast({ title: err instanceof ApiError ? err.message : "保存失败，请重试", icon: "none" });
    } finally {
      this._task = null;
      if (this._alive) this.setData({ saving: false });
    }
  },
});
