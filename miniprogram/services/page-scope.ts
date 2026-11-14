import { ApiError } from "./api";
import { store, Scope } from "../store/index";

export interface ScopeOperation {
  generation: number;
  scope: Scope;
}

export interface CancelHooks {
  isCancelled: () => boolean;
  onTask: (task: { abort: () => void }) => void;
}

export class PageScope {
  private generation = 0;
  private visible = false;
  private tasks = new Set<{ abort: () => void }>();

  show(): number {
    this.visible = true;
    return this.invalidate();
  }

  hide(): void {
    this.visible = false;
    this.invalidate();
  }

  invalidate(): number {
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

  frame(): number {
    return this.generation;
  }

  isFrameCurrent(frame: number): boolean {
    return this.visible && this.generation === frame;
  }

  capture(): ScopeOperation {
    return { generation: this.generation, scope: store.captureScope() };
  }

  isCurrent(op: ScopeOperation): boolean {
    return this.isFrameCurrent(op.generation) && store.isCurrentScope(op.scope);
  }

  scopeChanged(op: ScopeOperation): boolean {
    return this.isFrameCurrent(op.generation) && !store.isCurrentScope(op.scope);
  }

  async run<T>(op: ScopeOperation, send: (hooks: CancelHooks) => Promise<T>): Promise<T> {
    if (!this.isCurrent(op)) {
      throw new ApiError({ code: "CANCELLED", message: "请求已取消", retryable: false });
    }
    let current: { abort: () => void } | null = null;
    const hooks: CancelHooks = {
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
