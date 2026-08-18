/** P10 加入家庭组：校验令牌、显示家庭组名称、加入并切换（文档 7.3）。 */
import { request, showApiError } from "../../services/api";
import { ensureLogin } from "../../services/auth";
import { store } from "../../store/index";

Page({
  data: {
    familyName: "",
    ownerNickname: "",
    invalid: false,
    joining: false,
    loaded: false,
  },
  _token: "",

  async onLoad(query: Record<string, string>) {
    this._token = decodeURIComponent(query.invite_token || "");
    try {
      await ensureLogin();
      if (!this._token) {
        this.setData({ invalid: true, loaded: true });
        return;
      }
      // 加入前必须显示家庭组名称（文档 14.3）
      const preview = await request<{ family_name: string; owner_nickname: string | null }>({
        path: `/families/invite-preview?invite_token=${encodeURIComponent(this._token)}`,
      });
      this.setData({
        familyName: preview.family_name,
        ownerNickname: preview.owner_nickname || "",
        loaded: true,
      });
    } catch (err) {
      this.setData({ invalid: true, loaded: true });
      showApiError(err, "邀请已失效");
    }
  },
  async onJoin() {
    if (this.data.joining) return;
    this.setData({ joining: true });
    try {
      const data = await request<{ family_id: number }>({
        path: "/families/join",
        method: "POST",
        data: { invite_token: this._token },
      });
      // 加入成功并切换家庭组（文档 7.3）
      store.setCurrentFamily(data.family_id);
      wx.showToast({ title: "加入成功", icon: "none" });
      setTimeout(() => wx.switchTab({ url: "/pages/home/index" }), 600);
    } catch (err) {
      showApiError(err);
    } finally {
      this.setData({ joining: false });
    }
  },
  goHome() {
    wx.switchTab({ url: "/pages/home/index" });
  },
});
