// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

// Deterministic scheduler: timers fire in due-time order (ties in scheduling
// order) as the clock advances.
export class FakeSchedule {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimeout = (id: ReturnType<typeof setTimeout>) => {
    this.tasks.delete(id as unknown as number);
  };

  advance(ms: number) {
    this.advanceTo(this.now + ms);
  }

  advanceTo(target: number) {
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < dueAt) {
          dueAt = task.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const task = this.tasks.get(dueId)!;
      this.tasks.delete(dueId);
      this.now = task.at;
      task.fn();
    }
    this.now = target;
  }

  get pendingCount() {
    return this.tasks.size;
  }
}
