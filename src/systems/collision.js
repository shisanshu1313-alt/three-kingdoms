import { EventBus, EVENTS } from '../core/EventBus.js';
import balance from '../data/balance.json';
const COLLISION_COOLDOWN_MS = balance.collision.engine_debounce_ms;

/**
 * 队伍间碰撞检测（AABB 重叠）。
 * 一对队伍首次接触时发出 'party-collision'；之后在 balance.collision.engine_debounce_ms 内
 * 且仍保持接触时不重复发送（分开后再碰会在冷却结束后重新触发）。
 */
export default class CollisionSystem {
  constructor() { this.lastHit = new Map(); } // pairKey -> time

  static overlap(a, b) {
    const A = a.getBounds(), B = b.getBounds();
    return A.left < B.right && A.right > B.left && A.top < B.bottom && A.bottom > B.top;
  }

  /** 返回当前所有接触的队伍对 [[a,b],...]（供战斗系统使用）；事件按冷却去抖 */
  update(parties, now) {
    const overlaps = [];
    for (let i = 0; i < parties.length; i++) {
      for (let j = i + 1; j < parties.length; j++) {
        const a = parties[i], b = parties[j];
        if (a.inBattle || b.inBattle) continue; // during_battle：战斗中不触发任何碰撞
        if (!CollisionSystem.overlap(a, b)) continue;
        overlaps.push([a, b]);
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        const last = this.lastHit.get(key);
        if (last !== undefined && now - last < COLLISION_COOLDOWN_MS) continue;
        this.lastHit.set(key, now);
        const payload = { a, b, time: now };
        console.log(`[party-collision] ${a.name}(${a.id}) <-> ${b.name}(${b.id}) @ ${Math.round(now)}ms`);
        EventBus.emit(EVENTS.PARTY_COLLISION, payload);
      }
    }
    return overlaps;
  }
}
