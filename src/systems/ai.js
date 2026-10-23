import { EventBus, EVENTS } from '../core/EventBus.js';
import { decide } from './aiBrain.js';
import { protectingCity } from './city.js';
import { CHASE_REPLAN_MS, FLEE_REPLAN_MS, FLEE_PROBE_ANGLES_DEG } from '../config.js';
import { mulberry32 } from './rng.js'; // 默认随机数也是种子流（游戏里都显式传入；不用 Math.random，保证可复现）

/**
 * AI 执行层：每 tick_s 调用 aiBrain.decide 做决策，每帧按状态移动（A* 寻路）。
 * 玩法参数来自 balance.ai；寻路重算间隔等工程参数在 config.js。
 */
export default class AISystem {
  constructor(balance, rng = mulberry32(0x5eed)) {
    this.cfg = balance.ai;
    this.rng = rng;
    this.factions = Object.fromEntries(this.cfg.factions.map(f => [f.id, f]));
    this.tickAcc = Infinity; // 第一帧立即决策
    // v0.5 追击规则（WorldScene 每 tick 由 run 层更新）：{ graceUntilS, namedIds:Set, namedLeashPx: null=坐镇不追 | px }
    this.rules = { graceUntilS: 0, namedIds: new Set(), namedLeashPx: null };
    this.inSight = new Set();
    // v0.6 城池（WorldScene 设置）：state.cities 引用 + 城池配置；holdNamed = 本章名将军坐镇城中（city.named_in_city_chapters）
    this.cities = null;
    this.cityCfg = balance.v06?.city ?? null;
    this.holdNamed = false;
  }

  /** v0.6：队伍要守的城（洛阳守军 team.cityHold；名将军在 named_in_city_chapters 章坐镇大本营） */
  holdCityOf(p) {
    if (!this.cities) return null;
    if (p.team.cityHold) return this.cities[p.team.cityHold] ?? null;
    if (this.holdNamed && this.rules.namedIds.has(p.id)) {
      const id = Object.entries(this.cityCfg.capitals).find(([, f]) => f === p.faction)?.[0];
      const c = id && this.cities[id];
      return c && c.owner === p.faction ? c : null;
    }
    return null;
  }
  /** 【策划 2026-10-23 #5】守军和守城的名将永不撤退；第 3 章起名将军离城出征（holdNamed = false）→ 按普通 AI 撤退规则 */
  noRetreatOf(p, hold = this.holdCityOf(p)) {
    return !!(hold && this.cityCfg.hold_no_flee);
  }

  personalityOf(party) {
    const key = this.factions[party.faction]?.personality ?? 'normal';
    return { key, ...this.cfg.personality[key] };
  }

  init(p) {
    p.ai = { state: 'wander', targetId: null, since: 0, ignore: {}, idleUntil: 0, nextReplan: 0, personality: this.personalityOf(p) };
  }

  snapshot(p, now) {
    return { id: p.id, faction: p.faction, power: p.power, x: p.x, y: p.y, isPlayer: p.isPlayer,
      invincible: p.isInvincible(now), inBattle: !!p.inBattle };
  }

  update(aiParties, allParties, dt, now, world) {
    for (const p of aiParties) if (!p.ai) this.init(p);
    this.tickAcc += dt;
    if (this.tickAcc >= this.cfg.tick_s) {
      this.tickAcc = 0;
      const snaps = allParties.map(p => this.snapshot(p, now));
      for (const p of aiParties) if (!p.inBattle) this.think(p, snaps, now / 1000);
      this.scanVision(allParties);
    }
    const byId = new Map(allParties.map(p => [p.id, p]));
    for (const p of aiParties) if (!p.inBattle) this.act(p, byId, dt, now, world);
  }

  /** v0.5 追击许可：开局 grace_s 内不追玩家（来袭队除外）；名将军坐镇（null）或只追领地 home 半径内的目标 */
  canChaseFn(p, nowS) {
    const R = this.rules, home = p.team.home, named = R.namedIds.has(p.id);
    return o => {
      // v0.6：目标在自己一方城防 > 0 的城里受保护 → 不追（追过去也打不了，只会挤在城边）
      if (this.cities && this.cityCfg && protectingCity(o, this.cities, { v06: { city: this.cityCfg } })) return false;
      if (p.team.raid) return true;
      if (o.isPlayer && nowS < R.graceUntilS) return false;
      if (named) return R.namedLeashPx != null && !!home && Math.hypot(o.x - home.x, o.y - home.y) <= R.namedLeashPx;
      return true;
    };
  }

  think(p, snaps, nowS) {
    const prev = p.ai.state, prevT = p.ai.targetId;
    // 来袭队（fast_pace.first_battle）：直接冲向玩家，开打前不按战力比决策
    if (p.team.raid) {
      Object.assign(p.ai, { state: 'chase', targetId: 'player', since: p.ai.state === 'chase' ? p.ai.since : nowS });
      if (prev !== 'chase') { p.ai.nextReplan = 0; p.clearPath(); console.log(`[ai] ${p.name}(${p.id}) 来袭 -> chase player`); }
      return;
    }
    // v0.6 攻城：被派去攻打的城（玩家主城）不再是玩家的 → 收兵
    if (p.team.siegeTarget) {
      const c = this.cities?.[p.team.siegeTarget];
      if (!c || c.owner !== 'player') { p.team.siegeTarget = null; }
      else {
        if (prev !== 'siege') { p.ai.nextReplan = 0; p.clearPath(); console.log(`[ai] ${p.name}(${p.id}) 攻城 ${c.name}`); }
        Object.assign(p.ai, { state: 'siege', targetId: null, since: prev === 'siege' ? p.ai.since : nowS }); p.team.state = 'siege';
        return;
      }
    }
    // v0.6 守城：城防 > 0 时坐镇城中；城破后只追打城边 hold_engage_px 内的敌人 【假设】
    const hold = this.holdCityOf(p);
    p.team.noRetreat = this.noRetreatOf(p, hold); // 守城队交战时也不撤（combatAI mem.noRetreat）
    let canChase = this.canChaseFn(p, nowS);
    if (hold) {
      if (hold.def > 0) {
        if (prev !== 'hold') { p.ai.nextReplan = 0; p.clearPath(); }
        Object.assign(p.ai, { state: 'hold', targetId: null, since: prev === 'hold' ? p.ai.since : nowS, holdCity: hold.id }); p.team.state = 'hold';
        return;
      }
      const R = this.cityCfg.hold_engage_px;
      canChase = o => Math.hypot(o.x - hold.x, o.y - hold.y) <= R;
    }
    const res = decide({
      self: { id: p.id, faction: p.faction, power: p.power, x: p.x, y: p.y, home: p.team.home },
      others: snaps, mem: p.ai, cfg: this.cfg, personality: p.ai.personality, now: nowS, canChase
    });
    // 守城队不逃（hold_no_flee）：城破后死守城心，打不过也不弃城 【假设】
    if (hold && (res.state === 'wander' || (res.state === 'flee' && this.cityCfg.hold_no_flee))) { res.state = 'hold'; res.holdCity = hold.id; res.targetId = null; }
    Object.assign(p.ai, res);
    p.team.state = res.state;
    if (res.state !== prev || res.targetId !== prevT) {
      p.ai.nextReplan = 0; p.clearPath();
      if (res.state === 'chase' || res.state === 'flee') {
        console.log(`[ai] ${p.name}(${p.id}) ${prev} -> ${res.state} ${res.targetId ?? ''}`);
        EventBus.emit(EVENTS.AI_STATE, { party: p, from: prev, to: res.state, targetId: res.targetId });
      }
    }
  }

  act(p, byId, dt, now, world) {
    const ai = p.ai;
    switch (ai.state) {
      case 'chase': {
        const t = byId.get(ai.targetId);
        if (!t) { ai.state = 'wander'; return; }
        if (Math.hypot(t.x - p.x, t.y - p.y) < world.tileSize * 1.5) { p.clearPath(); p.stepToward(t.x, t.y, dt, world); return; }
        if (now >= ai.nextReplan || !p.path) {
          ai.nextReplan = now + CHASE_REPLAN_MS;
          p.setPath(world.pathTo(p, t.x, t.y));
        }
        p.followPath(dt, world);
        return;
      }
      case 'flee': {
        const t = byId.get(ai.targetId);
        if (!t) { ai.state = 'return'; return; }
        if (now >= ai.nextReplan || !p.path) {
          ai.nextReplan = now + FLEE_REPLAN_MS;
          p.setPath(this.fleePath(p, t, world));
        }
        p.followPath(dt, world);
        return;
      }
      case 'hold': { // 回到城心附近待着
        const c = this.cities?.[ai.holdCity] ?? this.holdCityOf(p);
        if (!c) { ai.state = 'wander'; return; }
        if (Math.hypot(c.x - p.x, c.y - p.y) <= this.cityCfg.hold_slack_px) { p.clearPath(); return; }
        if (now >= ai.nextReplan || !p.path) { ai.nextReplan = now + CHASE_REPLAN_MS; p.setPath(world.pathTo(p, c.x, c.y)); }
        p.followPath(dt, world);
        return;
      }
      case 'siege': { // 城防 > 0：停在城墙边（城圆边上）攻城；城破后进城（失守计时）
        const c = this.cities?.[p.team.siegeTarget];
        if (!c) { ai.state = 'wander'; return; }
        const d = Math.hypot(p.x - c.x, p.y - c.y), R = this.cityCfg.radius_px;
        const goal = c.def > 0 ? { x: c.x + (p.x - c.x) / Math.max(d, 1e-6) * R, y: c.y + (p.y - c.y) / Math.max(d, 1e-6) * R } : { x: c.x, y: c.y };
        if ((c.def > 0 && d <= R + 2) || (c.def <= 0 && d <= 16)) { p.clearPath(); return; }
        if (Math.hypot(goal.x - p.x, goal.y - p.y) < world.tileSize * 1.5) { p.clearPath(); p.stepToward(goal.x, goal.y, dt, world); return; }
        if (now >= ai.nextReplan || !p.path) { ai.nextReplan = now + CHASE_REPLAN_MS; p.setPath(world.pathTo(p, goal.x, goal.y)); }
        p.followPath(dt, world);
        return;
      }
      case 'return': {
        if (!p.path) p.setPath(world.pathTo(p, p.team.home.x, p.team.home.y));
        if (p.followPath(dt, world) === 'arrived') ai.state = 'wander';
        return;
      }
      default: this.wander(p, dt, now, world);
    }
  }

  wander(p, dt, now, world) {
    if (p.path) {
      const r = p.followPath(dt, world);
      if (r === 'arrived' || r === 'stuck') {
        const [lo, hi] = this.cfg.wander_idle_s;
        p.ai.idleUntil = now + (lo + this.rng() * (hi - lo)) * 1000;
      }
      return;
    }
    if (now < p.ai.idleUntil) return;
    const home = p.team.home;
    const ang = this.rng() * Math.PI * 2, rad = Math.sqrt(this.rng()) * this.cfg.wander_radius_px;
    const x = Math.min(world.worldW - 1, Math.max(1, home.x + Math.cos(ang) * rad));
    const y = Math.min(world.worldH - 1, Math.max(1, home.y + Math.sin(ang) * rad));
    const path = world.pathTo(p, x, y);
    if (path) p.setPath(path); else p.ai.idleUntil = now + 1000;
  }

  /** 逃跑：沿“背离威胁”方向及若干偏转角试探，选可达且离威胁最远的点 */
  fleePath(p, threat, world) {
    const base = Math.atan2(p.y - threat.y, p.x - threat.x);
    const D = this.cfg.flee_safe_px;
    let best = null, bestScore = -Infinity;
    for (const deg of FLEE_PROBE_ANGLES_DEG) {
      const a = base + deg * Math.PI / 180;
      const x = Math.min(world.worldW - 16, Math.max(16, p.x + Math.cos(a) * D));
      const y = Math.min(world.worldH - 16, Math.max(16, p.y + Math.sin(a) * D));
      const path = world.pathTo(p, x, y);
      if (!path || !path.length) continue;
      const end = path[path.length - 1];
      const score = Math.hypot(end.x - threat.x, end.y - threat.y) - (path.partial ? 200 : 0) - path.length * 2;
      if (score > bestScore) { bestScore = score; best = path; }
      if (deg === 0 && !path.partial && Math.hypot(end.x - threat.x, end.y - threat.y) >= D) break; // 正后方可行就用
    }
    return best;
  }

  /** 每 tick 扫描：一对队伍进入 vision_px 时发 'party-sighted'（只在“进入”时发一次） */
  scanVision(parties) {
    const R = this.cfg.vision_px;
    const seen = new Set();
    for (let i = 0; i < parties.length; i++) for (let j = i + 1; j < parties.length; j++) {
      const a = parties[i], b = parties[j];
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist <= R) {
        seen.add(key);
        if (!this.inSight.has(key)) {
          console.log(`[party-sighted] ${a.name}(${a.id}) <-> ${b.name}(${b.id}) dist=${Math.round(dist)}`);
          EventBus.emit(EVENTS.PARTY_SIGHTED, { a, b, dist });
        }
      }
    }
    this.inSight = seen;
  }
}
