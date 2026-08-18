/** P09 家庭组管理：改名、邀请、成员管理、退出（文档 7.2 / 7.3）。 */
import { request, showApiError } from "../../services/api";
import { refreshMe } from "../../services/auth";
import { store } from "../../store/index";

interface Member {
  user_id: number;
  nickname: string | null;
  avatar_url: string | null;
  role: string;
  joined_at: string;
}

Page({
  data: {
    familyName: "",
    isOwner: false,
    members: [] as Member[],
    sharePath: "",
  },
  onShow() {
    this.refresh();
  },
  async refresh() {
    try {
      await refreshMe();
      const family = store.currentFamily();
      if (!family) return;
      const data = await request<{ members: Member[] }>({
        path: `/families/${family.id}/members`,
      });
      this.setData({
        familyName: family.name,
        isOwner: family.role === "owner",
        members: data.members,
      });
    } catch (err) {
      showApiError(err);
    }
  },
  onRename() {
    if (!this.data.isOwner) return;
    wx.showModal({
      title: "修改家庭组名称",
      editable: true,
      placeholderText: this.data.familyName,
      success: async (res) => {
        const name = (res.content || "").trim();
        if (!res.confirm || !name) return;
        try {
          await request({
            path: `/families/${store.currentFamilyId}`,
            method: "POST",
            data: { name },
          });
          this.refresh();
        } catch (err) {
          showApiError(err);
        }
      },
    });
  },
  async onInvite() {
    try {
      const data = await request<{ share_path: string }>({
        path: `/families/${store.currentFamilyId}/invite`,
        method: "POST",
      });
      this.setData({ sharePath: data.share_path });
      wx.showToast({ title: "请点击右上角转发给家人", icon: "none", duration: 2500 });
      wx.showShareMenu({ menus: ["shareAppMessage"] });
    } catch (err) {
      showApiError(err);
    }
  },
  onShareAppMessage() {
    return {
      title: `邀请你加入家庭组「${this.data.familyName}」`,
      path: this.data.sharePath ? `/${this.data.sharePath}` : "/pages/launch/index",
    };
  },
  onRemoveMember(e: WechatMiniprogram.TouchEvent) {
    const member = e.currentTarget.dataset.member as Member;
    if (!this.data.isOwner || member.role === "owner") return;
    wx.showModal({
      title: "移除成员",
      content: `确定将「${member.nickname || "该成员"}」移出家庭组？`,
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await request({
            path: `/families/${store.currentFamilyId}/members/${member.user_id}`,
            method: "DELETE",
          });
          this.refresh();
        } catch (err) {
          showApiError(err);
        }
      },
    });
  },
  onLeave() {
    if (this.data.isOwner) {
      wx.showToast({ title: "所有者需先转让或解散家庭组", icon: "none" });
      return;
    }
    wx.showModal({
      title: "退出家庭组",
      content: "退出后将无法查看该家庭组的物品记录。",
      success: async (res) => {
        if (!res.confirm || !store.user) return;
        try {
          await request({
            path: `/families/${store.currentFamilyId}/members/${store.user.id}`,
            method: "DELETE",
          });
          await refreshMe();
          wx.navigateBack();
        } catch (err) {
          showApiError(err);
        }
      },
    });
  },
});
