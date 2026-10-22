/**
 * 游戏时钟（v0.4 gacha_ui.pause_scope：所有计时用游戏时间，不用真实时间）。
 * 只在大地图 update 里 tick(delta) 推进；大地图暂停（抽卡/名册窗口）时不 tick → 时间冻结：
 * 战斗时长、战后保护、无敌、平局冷却、AI 忽略名单/状态计时、补充刷新、自动存档间隔全部停住。
 * 纯 JS，无 Phaser；单测见 tests/gameClock.test.js。
 */
export default class GameClock {
  constructor(startMs = 0) {
    this.now = startMs;
    this.paused = false;
    this.timers = new Map(); // id -> { id, interval, nextAt, cb }
  }

  /** 推进 delta 毫秒并触发到期的定时器（一次 tick 可能触发多次，按到期顺序） */
  tick(deltaMs) {
    if (this.paused || !(deltaMs > 0)) return;
    this.now += deltaMs;
    for (;;) {
      let due = null;
      for (const t of this.timers.values()) if (t.nextAt <= this.now && (!due || t.nextAt < due.nextAt)) due = t;
      if (!due) break;
      due.nextAt += due.interval;
      due.cb(this.now);
    }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /** 每 interval 毫秒（游戏时间）调用 cb；firstAt = 第一次触发的游戏时间（读档恢复用） */
  every(id, interval, cb, firstAt = this.now + interval) {
    if (!(interval > 0)) throw new Error(`定时器 ${id} 间隔必须 > 0`);
    this.timers.set(id, { id, interval, nextAt: firstAt, cb });
    return this.timers.get(id);
  }

  cancel(id) { this.timers.delete(id); }
  remaining(id) { const t = this.timers.get(id); return t ? Math.max(0, t.nextAt - this.now) : null; }
  nextAt(id) { return this.timers.get(id)?.nextAt ?? null; }

  /** 存档：{ now, timers: { id: nextAt } }（回调不保存，读档后由 every(..., firstAt) 重新挂上） */
  getState() {
    return { now: this.now, timers: Object.fromEntries([...this.timers.values()].map(t => [t.id, t.nextAt])) };
  }
}
