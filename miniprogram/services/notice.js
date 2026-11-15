/** 全局提示服务：统一走 notice-panel 组件；页面未挂载时回退 wx 原生弹窗（文档 8.2）。 */

let _handler = null;

function registerNotice(h) {
  _handler = h;
}

function norm(o) {
  return typeof o === "string" ? { text: o } : o;
}

/** 提示 +「知道了」按钮；onConfirm 在点击后触发（如跳转返回）。 */
function showNotice(opts, onConfirm) {
  const d = norm(opts);
  if (_handler) {
    _handler(d, { confirm: onConfirm || null });
    return;
  }
  wx.showToast({ title: d.text, icon: "none" });
  if (onConfirm) onConfirm();
}

/** 确认框：resolve(true)=确认 / false=取消。 */
function confirmNotice(opts) {
  const d = norm(opts);
  if (_handler) {
    return new Promise((resolve) => {
      _handler(
        { ...d, cancelText: d.cancelText ?? "取消" },
        { confirm: () => resolve(true), cancel: () => resolve(false) }
      );
    });
  }
  return new Promise((resolve) => {
    wx.showModal({
      title: d.title || "提示",
      content: d.text,
      confirmText: d.confirmText || "确定",
      cancelText: d.cancelText || "取消",
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
}

/** 输入框弹窗：resolve(输入串) / null=取消。 */
function promptNotice(opts) {
  const d = { text: "", ...opts };
  if (_handler) {
    return new Promise((resolve) => {
      _handler(
        { ...d, editable: true, cancelText: d.cancelText ?? "取消" },
        { confirm: (v) => resolve(v), cancel: () => resolve(null) }
      );
    });
  }
  return new Promise((resolve) => {
    wx.showModal({
      title: d.title || "提示",
      editable: true,
      placeholderText: d.placeholderText || "",
      confirmText: d.confirmText || "确定",
      success: (r) => resolve(r.confirm ? r.content || "" : null),
      fail: () => resolve(null),
    });
  });
}

/** 安装到页面：返回 show 回调并补齐 onNoticeConfirm/onNoticeCancel 方法（幂等）。 */
function bindNotice(page) {
  const p = page;
  if (!p._noticeInstalled) {
    p._noticeInstalled = true;
    p._noticeCbs = {};
    p.onNoticeConfirm = function (e) {
      const fn = this._noticeCbs.confirm;
      this._noticeCbs = {};
      this.setData({ "notice.visible": false });
      if (fn) fn(e && e.detail ? e.detail.value : "");
    };
    p.onNoticeCancel = function () {
      const fn = this._noticeCbs.cancel;
      this._noticeCbs = {};
      this.setData({ "notice.visible": false });
      if (fn) fn();
    };
  }
  return (d, cbs) => {
    p._noticeCbs = cbs;
    p.setData({
      notice: {
        visible: true,
        title: d.title || "",
        text: d.text || "",
        secondaryText: d.secondaryText || "",
        confirmText: d.confirmText || "知道了",
        cancelText: d.cancelText || "",
        editable: !!d.editable,
        placeholderText: d.placeholderText || "",
      },
    });
  };
}

module.exports = {
  registerNotice,
  showNotice,
  confirmNotice,
  promptNotice,
  bindNotice,
};
