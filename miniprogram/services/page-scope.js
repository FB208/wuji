const { ApiError } = require("./api");
const { store } = require("../store/index");

class PageScope {
  generation = 0;
  visible = false;
  tasks = new Set();

  show() {
    this.visible = true;
    return this.invalidate();
  }

  hide() {
    this.visible = false;
    this.invalidate();
  }

  invalidate() {
    this.generation += 1;
    const stale = Array.from(this.tasks);
    this.tasks.clear();
    for (const t of stale) {
      try {
        t.abort();
      } catch (_) {}
    }
    return this.generation;
  }

  frame() {
    return this.generation;
  }

  isFrameCurrent(frame) {
    return this.visible && this.generation === frame;
  }

  capture() {
    return { generation: this.generation, scope: store.captureScope() };
  }

  isCurrent(op) {
    return this.isFrameCurrent(op.generation) && store.isCurrentScope(op.scope);
  }

  scopeChanged(op) {
    return this.isFrameCurrent(op.generation) && !store.isCurrentScope(op.scope);
  }

  async run(op, send) {
    if (!this.isCurrent(op)) {
      throw new ApiError({ code: "CANCELLED", message: "请求已取消", retryable: false });
    }
    let current = null;
    const hooks = {
      isCancelled: () => !this.isCurrent(op),
      onTask: (task) => {
        if (!this.isCurrent(op)) {
          try {
            task.abort();
          } catch (_) {}
          return;
        }
        if (current && current !== task) {
          this.tasks.delete(current);
        }
        current = task;
        this.tasks.add(task);
      },
    };
    try {
      return await send(hooks);
    } finally {
      if (current) this.tasks.delete(current);
    }
  }
}

module.exports = { PageScope };
