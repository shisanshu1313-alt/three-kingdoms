/**
 * 事件总线（纯 JS，不依赖 Phaser / DOM）：on / once / off / emit / removeAllListeners / listenerCount。
 * 接口与以前用的 Phaser.Events.EventEmitter 相同（on(event, fn, context)）。
 */
export class Emitter {
  constructor() { this._l = new Map(); }
  on(event, fn, context, once = false) {
    if (!this._l.has(event)) this._l.set(event, []);
    this._l.get(event).push({ fn, context, once });
    return this;
  }
  once(event, fn, context) { return this.on(event, fn, context, true); }
  off(event, fn, context) {
    const list = this._l.get(event);
    if (!list) return this;
    if (!fn) { this._l.delete(event); return this; }
    const rest = list.filter(l => l.fn !== fn || (context !== undefined && l.context !== context));
    if (rest.length) this._l.set(event, rest); else this._l.delete(event);
    return this;
  }
  /** 同步调用全部监听；监听里增删监听不影响本次分发。返回是否有监听 */
  emit(event, ...args) {
    const list = this._l.get(event);
    if (!list || !list.length) return false;
    for (const l of [...list]) {
      if (l.once) this.off(event, l.fn, l.context);
      l.fn.apply(l.context, args);
    }
    return true;
  }
  listenerCount(event) { return this._l.get(event)?.length ?? 0; }
  removeAllListeners(event) { if (event === undefined) this._l.clear(); else this._l.delete(event); return this; }
}

// 全局事件总线：各系统通过它解耦通信。
export const EventBus = new Emitter();
export const EVENTS = {
  PARTY_COLLISION: 'party-collision', // { a, b, time }  两支队伍接触（去抖）
  PARTY_SIGHTED: 'party-sighted',     // { a, b, dist }  一对队伍进入视野（vision_px）
  AI_STATE: 'ai-state',               // { party, from, to, targetId }  AI 进入追击/逃跑
  BATTLE_START: 'battle-start',       // { battle }
  BATTLE_END: 'battle-end',           // { battle, outcome }  outcome 见 battle.applyBattleResult
  PARTY_SPAWNED: 'party-spawned',     // { party }
  PARTY_REMOVED: 'party-removed',     // { party }
  TEAM_CHANGED: 'team-changed'        // { party }  队伍数值重算后（PartyModel.refresh：属性 / 武将 / 兵种 / 物品 / 兵数变化）
};
