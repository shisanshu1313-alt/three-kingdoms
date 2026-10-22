/**
 * v0.5 移动接触式实时战斗（balance_v0.5.json → battle_move / move_params；配置副本 data/combat_v05.json）。
 * 纯 JS，不依赖 Phaser / DOM：step(state, inputs, dt, env) → 新 state（不修改入参；随机只用 state.rng）。
 *
 * 规则摘要（详见 battle_move.mvp_fields）：
 *   - 队伍是圆，r = radius_base + radius_per_sqrt_n × √兵数；两圆相交 = 接触，只有接触时掉兵（弓兵射程内放箭例外）
 *   - 持续伤害：每 tick raw_X += min(rate_cap, lam × R_X^a) × (背击 ? rear_mult : 1) × dt
 *       R_X = Σ_Y∈接触(X) E_Y→X × (Y 冲散 ? disorder_mult : 1) × share_Y(X) ÷ E_X→Y，share_Y(X) = E_X→Y ÷ Σ_Z∈接触(Y) E_Z→Y
 *       （1 对 1 退化为 E_Y/E_X；2 打 1 等价于合并成一队）
 *       E_X→Y = P_X(当前兵数) × roll_X × sustain_X × (X 克 Y ? counter_mult[章节] : 1)
 *   - 兵数 N = N0 − N0 × raw × (1 − 减免)；减免 = v0.4 减免 + 兵种 red，封顶 loss_reduction_total_cap
 *   - 冲击：从不接触变为接触的那一 tick，接近速度 ≥ impact_min_closing × 自己最大速度 且冲锋冷却好 → 一次性伤害 + shock + 冲散；冷却 charge_cd_s
 *   - 士气 = 100 − morale_loss_span × raw/brk − shock；< morale_rout 溃逃（AI 判负；玩家失控 rout_control_loss_s 秒自动以 rout_speed_mult 逃）
 *   - 脱离：一对参战方间隙 > escape_gap_px 持续 escape_s → 这一对结束；正在撤的一方 = 逃脱（保护 protect_s），这一对 pair_cd_s 内不再开打
 *   - 第三方：任何敌对队伍接触到参战方就加入；成员变化时重算 brk（不低于已有 raw + 0.05）
 *
 * state = { t, chapter, rng, bodies: {id: Body}, pairs: {key: Pair}, pairCd: {key: until}, events: [] }
 * inputs = { [id]: { h, v, target? } }：期望朝向（弧度）、期望速度（px/s，会被截到最大速度）、弓兵目标
 * env（可选，由大地图提供，纯函数）：fits(body, x, y)、speedMult(x, y)、hostile(a, b)
 */
import { computePower, lossReduction, mainGeneral, itemEffect, roundHalfUp } from './combat.js';
import { mulberry32 } from './rng.js';

const TAU = Math.PI * 2;
export const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ---------------------------------------------------------------- 队伍 → 战斗体
export function unitDef(cfg, u) { return cfg.move.units[u] ?? cfg.move.units.inf; }
export function radiusOf(n, cfg) { return cfg.move.radius_base + cfg.move.radius_per_sqrt_n * Math.sqrt(Math.max(0, n)); }

/** 由 team 算出战斗用的静态参数（武将/物品/兵种变化后重算） */
export function teamStats(team, balance, cfg) {
  const u = unitDef(cfg, team.unit);
  const sumStr = team.generals.reduce((s, g) => s + g.str, 0);
  const genTerm = balance.power.k_gen * sumStr;
  const n0 = Math.max(1e-9, team.soldiers);
  const M = team.soldiers > 0 ? (computePower(team, balance) - genTerm) / n0 : (computePower({ ...team, soldiers: 1 }, balance) - genTerm);
  const lead = mainGeneral(team, balance)?.lead ?? 50;
  return {
    M, genTerm,
    red: Math.min(balance.power.loss_reduction_total_cap, lossReduction(team, balance) + (u.red ?? 0)),
    leadMult: 1 + cfg.move.lead_speed_k * (lead - 50),
    // v0.4 速度公式的参数（兵数在 vmaxOf 里按当前值代入）
    speed: { base: balance.team_rules.speed_base, pen: balance.team_rules.speed_penalty_per_soldier, min: balance.team_rules.speed_min_mult, itemPct: itemEffect(team, balance, 'speed_pct') }
  };
}

/** 新建战斗体（team 是大地图的队伍数据；位置取 team.position） */
export function makeBody(team, balance, cfg, extra = {}) {
  return {
    id: team.id, faction: team.faction, isPlayer: !!team.is_player, unit: team.unit ?? 'inf',
    x: team.position.x, y: team.position.y, h: extra.h ?? 0, v: 0,
    N0: team.soldiers, raw: 0, roll: 1, brk: null, draw: false, shock: 0, cd: 0, dis: 0,
    routed: false, routT: 0, protectUntil: 0, ammo: unitDef(cfg, team.unit).ammo_s ?? 0, contrib: {},
    stats: teamStats(team, balance, cfg), ...extra
  };
}

/** 战斗外：队伍数据变了（抽卡、收编、换兵种）→ 同步到战斗体（战斗中只改兵数基准） */
export function syncBodyFromTeam(body, team, balance, cfg) {
  body.unit = team.unit ?? 'inf';
  body.stats = teamStats(team, balance, cfg);
  if (!inCombat(body)) { body.N0 = team.soldiers; body.raw = 0; }
  return body;
}

export const soldiersOf = b => Math.max(0, b.N0 - b.N0 * b.raw * (1 - b.stats.red));
export const shownSoldiers = b => roundHalfUp(soldiersOf(b));
export const powerOf = b => soldiersOf(b) * b.stats.M + b.stats.genTerm;
export const inCombat = b => (b.foes?.length ?? 0) > 0;
export function moraleOf(b, cfg) {
  if (b.brk === null) return 100 - b.shock;
  return 100 - cfg.move.morale_loss_span * b.raw / b.brk - b.shock;
}
/** 最大速度：v0.4 速度(兵数, 物品) × 兵种 speed × (1 + lead_speed_k × (主将统率 − 50)) */
export function vmaxOf(b, cfg) {
  const sp = b.stats.speed, n = soldiersOf(b);
  const base = sp.base * Math.max(sp.min, 1 - sp.pen * n) * (1 + sp.itemPct);
  return base * unitDef(cfg, b.unit).speed * b.stats.leadMult;
}
export function counterMult(cfg, chapter) {
  const arr = cfg.move.counter_mult_by_chapter;
  return arr[clamp(chapter | 0, 0, arr.length - 1)];
}
/** X 对 Y 的有效战力 */
export function effPower(X, Y, cfg, chapter) {
  const u = unitDef(cfg, X.unit);
  const counter = cfg.move.counters[X.unit] === Y.unit ? counterMult(cfg, chapter) : 1;
  return powerOf(X) * X.roll * u.sustain * counter;
}

// ---------------------------------------------------------------- 状态
export function createCombatState({ seed = 1, chapter = 0 } = {}) {
  const r = mulberry32(seed);
  return { t: 0, chapter, rng: r.getState(), bodies: {}, pairs: {}, pairCd: {}, events: [] };
}
export function addBody(state, body) { state.bodies[body.id] = { foes: [], ...body }; return state; }
export function removeBody(state, id) {
  delete state.bodies[id];
  for (const [k, p] of Object.entries(state.pairs)) if (p.a === id || p.b === id) delete state.pairs[k];
  for (const b of Object.values(state.bodies)) b.foes = (b.foes || []).filter(f => f !== id);
  return state;
}
/** 战斗中改兵数（收编）：保持 raw 不变，按差值调整 N0 */
export function addSoldiers(body, k) {
  const keep = 1 - body.raw * (1 - body.stats.red);
  body.N0 = Math.max(0, (soldiersOf(body) + k) / Math.max(1e-9, keep));
}

const defaultEnv = { fits: () => true, speedMult: () => 1, hostile: (a, b) => a.faction !== b.faction };

// ---------------------------------------------------------------- step
export function step(prev, inputs = {}, dt, cfg, env = {}) {
  dt = dt ?? cfg.tick_s;
  const E = { ...defaultEnv, ...env };
  const s = structuredClone(prev);
  const MP = cfg.move, CD = cfg.cooldown, AS = cfg.assumed;
  const rng = mulberry32(0); rng.setState(s.rng);
  s.t = +(s.t + dt).toFixed(6);
  s.events = [];
  const ev = e => s.events.push({ t: s.t, ...e });
  const B = s.bodies, ids = Object.keys(B).sort();
  const vmax = {}; for (const id of ids) vmax[id] = vmaxOf(B[id], cfg);
  const eff = (x, y) => effPower(B[x], B[y], cfg, s.chapter);
  const protectedNow = b => b.protectUntil > s.t;

  for (const id of ids) { const b = B[id]; b.cd = Math.max(0, b.cd - dt); b.dis = Math.max(0, b.dis - dt); }

  // ---- 1) 接触检测 + 开战（含第三方加入）
  const changed = new Set();
  const geo = {};
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = B[ids[i]], b = B[ids[j]];
    if (!E.hostile(a, b)) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y), rr = radiusOf(soldiersOf(a), cfg) + radiusOf(soldiersOf(b), cfg);
    const key = pairKey(a.id, b.id);
    geo[key] = { d, gap: d - rr, contact: d <= rr };
  }
  const closing = (X, Y, d) => { const dx = (Y.x - X.x) / Math.max(d, 1e-6), dy = (Y.y - X.y) / Math.max(d, 1e-6); return Math.cos(X.h) * X.v * dx + Math.sin(X.h) * X.v * dy; };
  const startPair = (a, b, why) => {
    for (const X of [a, b]) if (!inCombat(X)) {
      // 新的一场：用当前兵数重算，士气回 100，raw 清零，roll 重掷，弹药补满
      X.N0 = soldiersOf(X); X.raw = 0; X.shock = 0; X.brk = null; X.draw = false; X.contrib = {}; X.routOnce = false;
      X.roll = cfg.fixedRoll ?? (cfg.rollMin + rng() * (cfg.rollMax - cfg.rollMin)); // 测试可用 cfg.fixedRoll 固定
      X.ammo = unitDef(cfg, X.unit).ammo_s ?? 0; X.combatStart = s.t; X.N0start = X.N0;
    }
    const key = pairKey(a.id, b.id);
    s.pairs[key] = { a: a.id < b.id ? a.id : b.id, b: a.id < b.id ? b.id : a.id, startT: s.t, apartT: 0, wasContact: false };
    a.foes = [...new Set([...(a.foes || []), b.id])]; b.foes = [...new Set([...(b.foes || []), a.id])];
    changed.add(a.id); changed.add(b.id);
    ev({ type: 'engage', a: a.id, b: b.id, why });
  };
  const canStart = (X, Y, key, attackX, attackY) => {
    if ((s.pairCd[key] ?? 0) > s.t) return false;
    if (protectedNow(X)) { if (!attackX) return false; X.protectUntil = 0; ev({ type: 'protect-cancel', id: X.id }); }
    if (protectedNow(Y)) { if (!attackY) return false; Y.protectUntil = 0; ev({ type: 'protect-cancel', id: Y.id }); }
    return true;
  };
  for (const [key, g] of Object.entries(geo)) {
    if (s.pairs[key] || !g.contact) continue;
    const [ia, ib] = key.split('|'), a = B[ia], b = B[ib];
    if (a.routed || b.routed) continue;
    const atk = X => closing(X, X === a ? b : a, g.d) >= AS.attack_cancels_protection_closing * vmax[X.id];
    if (canStart(a, b, key, atk(a), atk(b))) startPair(a, b, 'contact');
  }
  // 弓兵：不接触且间隙 ≤ 射程 → 放箭也会开战（目标：输入指定 > 已交战的最近敌人）
  const arrowTarget = {};
  for (const id of ids) {
    const X = B[id], u = unitDef(cfg, X.unit);
    if (!u.range_px || X.routed || X.ammo <= 0) continue;
    const cands = [];
    const want = inputs[id]?.target;
    if (want && B[want] && E.hostile(X, B[want])) cands.push(want);
    for (const f of X.foes || []) cands.push(f);
    for (const tid of cands) {
      const g = geo[pairKey(id, tid)];
      if (!g || g.contact || g.gap > u.range_px) continue;
      const key = pairKey(id, tid);
      if (!s.pairs[key]) { if (!canStart(X, B[tid], key, true, false)) continue; startPair(X, B[tid], 'arrow'); }
      arrowTarget[id] = tid; break;
    }
  }

  // ---- 2) 成员变化 → 重算溃败线
  const foeContact = id => (B[id].foes || []).filter(f => geo[pairKey(id, f)]?.contact);
  // 溃败线用的战力比（不含冲散）：R_X = Σ_Y E_Y→X × share_Y(X) ÷ E_X→Y
  const ratioOf = (x, foesOf) => {
    let R = 0;
    for (const y of foesOf(x)) {
      const denom = foesOf(y).reduce((sum, z) => sum + eff(z, y), 0);
      const share = eff(x, y) / Math.max(1e-9, denom);
      R += eff(y, x) * share / Math.max(1e-9, eff(x, y));
    }
    return R;
  };
  const allFoes = id => B[id].foes || [];
  for (const id of changed) {
    const X = B[id]; if (!inCombat(X)) continue;
    const R = ratioOf(id, allFoes);
    const big = Math.max(R, 1 / Math.max(R, 1e-9));
    let brk, draw = false;
    if (big < cfg.drawRatio) { brk = MP.draw_break; draw = true; }
    else if (R > 1) brk = Math.min(cfg.loserMax, cfg.loserBase + cfg.loserPer * (R - 1));
    else brk = MP.winner_break;
    if (X.brk !== null) brk = Math.max(brk, X.raw + 0.05);
    X.brk = brk; X.draw = draw;
  }
  changed.clear();

  // ---- 3) 冲击（从不接触变为接触的那一 tick）
  for (const [key, p] of Object.entries(s.pairs)) {
    const g = geo[key];
    if (g.contact && !p.wasContact) {
      for (const [X, Y] of [[B[p.a], B[p.b]], [B[p.b], B[p.a]]]) {
        if (X.cd > 0 || X.routed) continue;
        const vc = closing(X, Y, g.d);
        if (vc < MP.impact_min_closing * vmax[X.id]) continue;
        const ux = unitDef(cfg, X.unit), uy = unitDef(cfg, Y.unit);
        const ratio = Math.pow(eff(X.id, Y.id) / Math.max(1e-9, eff(Y.id, X.id)), MP.a);
        if ((ux.charge ?? 0) > 1 && uy.anti_charge) {
          const dmg = MP.impact_k * (vc / 100) * (uy.brace_reflect ?? 0.4) / Math.max(1e-9, ratio);
          X.raw += dmg; X.contrib[Y.id] = (X.contrib[Y.id] ?? 0) + dmg;
          X.shock += MP.impact_shock * (vc / 100); X.dis = MP.disorder_s;
          ev({ type: 'braced', id: X.id, by: Y.id, raw: dmg, vc });
        } else {
          const dmg = MP.impact_k * (vc / 100) * ratio * (ux.charge ?? 1);
          Y.raw += dmg; Y.contrib[X.id] = (Y.contrib[X.id] ?? 0) + dmg;
          Y.shock += MP.impact_shock * (vc / 100) * (ux.charge ?? 1); Y.dis = MP.disorder_s;
          ev({ type: 'impact', id: X.id, on: Y.id, raw: dmg, vc });
        }
        X.cd = CD.charge_cd_s ?? MP.charge_cd_s;
        if (protectedNow(X)) X.protectUntil = 0;
      }
    }
  }

  // ---- 4) 持续接触伤害
  const rawAdd = {};
  for (const id of ids) {
    const X = B[id], C = foeContact(id).filter(y => !B[y].routed);
    if (!C.length) continue;
    let R = 0; const parts = {};
    for (const y of C) {
      const denom = foeContact(y).reduce((sum, z) => sum + eff(z, y), 0);
      const share = eff(id, y) / Math.max(1e-9, denom);
      const term = eff(y, id) * (B[y].dis > 0 ? MP.disorder_mult : 1) * share / Math.max(1e-9, eff(id, y));
      R += term; parts[y] = term;
    }
    let rate = Math.min(MP.rate_cap, MP.lam * Math.pow(R, MP.a));
    const rear = C.some(y => Math.abs(angDiff(Math.atan2(B[y].y - X.y, B[y].x - X.x), X.h)) > MP.rear_angle_deg * Math.PI / 180) && X.v > AS.rear_min_speed_frac * vmax[id];
    if (rear) rate *= MP.rear_mult;
    rawAdd[id] = { d: rate * dt, parts, R, rear };
  }
  for (const [id, { d, parts, R }] of Object.entries(rawAdd)) {
    const X = B[id]; X.raw += d;
    for (const [y, term] of Object.entries(parts)) X.contrib[y] = (X.contrib[y] ?? 0) + d * term / Math.max(1e-9, R);
    X.rear = rawAdd[id].rear;
  }
  for (const id of ids) if (!rawAdd[id]) B[id].rear = false;

  // ---- 5) 弓兵放箭
  for (const [id, tid] of Object.entries(arrowTarget)) {
    const X = B[id], Y = B[tid], u = unitDef(cfg, X.unit);
    X.ammo = Math.max(0, X.ammo - dt);
    const mv = X.v > AS.arrow_moving_frac * vmax[id] ? u.move_shoot_mult : 1;
    const rate = Math.min(MP.rate_cap, MP.lam * Math.pow(eff(id, tid) / Math.max(1e-9, eff(tid, id)), MP.a)) * u.shoot_mult * mv * (unitDef(cfg, Y.unit).arrow_taken ?? 1);
    Y.raw += rate * dt; Y.contrib[id] = (Y.contrib[id] ?? 0) + rate * dt;
    X.shooting = tid;
  }
  for (const id of ids) if (!arrowTarget[id]) B[id].shooting = null;

  // ---- 6) 冲击值回复、记录接触
  for (const id of ids) { const X = B[id]; if (!foeContact(id).length) X.shock = Math.max(0, X.shock - MP.shock_regen_per_s * dt); X.inContact = foeContact(id).length > 0; }
  for (const [key, p] of Object.entries(s.pairs)) p.wasContact = geo[key].contact;

  // ---- 7) 结束判定：全灭 / 平局 / 溃逃
  const endPair = (key, kind, extra = {}) => {
    const p = s.pairs[key]; if (!p) return;
    delete s.pairs[key];
    s.pairCd[key] = s.t + CD.pair_cd_s;
    B[p.a].foes = B[p.a].foes.filter(f => f !== p.b); B[p.b].foes = B[p.b].foes.filter(f => f !== p.a);
    changed.add(p.a); changed.add(p.b);
    ev({ type: 'separate', a: p.a, b: p.b, kind, ...extra });
  };
  const topContributor = X => {
    const inContact = new Set(foeContact(X.id));
    const entries = Object.entries(X.contrib).filter(([id]) => B[id]);
    const total = entries.reduce((sum, [, v]) => sum + v, 0);
    const best = (list) => list.sort((p, q) => q[1] - p[1])[0]?.[0] ?? null;
    return { by: best(entries.filter(([id]) => inContact.has(id))) ?? best([...entries]) ?? (X.foes[0] ?? null),
      shares: Object.fromEntries(entries.map(([id, v]) => [id, total > 0 ? v / total : 0])) };
  };
  const defeated = [];
  for (const id of ids) {
    const X = B[id]; if (!inCombat(X) && X.brk === null) continue;
    if (soldiersOf(X) <= 0.5) { defeated.push([X, 'wipe']); continue; }
    if (X.draw && X.raw >= X.brk) {
      for (const f of [...X.foes]) endPair(pairKey(id, f), 'draw');
      ev({ type: 'draw', id });
      continue;
    }
    // 【假设】player_rout_once_per_battle：玩家一场战斗只溃一次（恢复操控后士气仍 < 30 也不再失控，否则会反复失控）
    if (X.brk !== null && !X.routed && !(X.isPlayer && X.routOnce && AS.player_rout_once_per_battle !== false) && moraleOf(X, cfg) < MP.morale_rout) {
      X.routed = true; X.routT = 0; X.routOnce = true;
      ev({ type: 'rout', id });
      if (!X.isPlayer) defeated.push([X, 'rout']);
    }
  }
  for (const [X, cause] of defeated) {
    const { by, shares } = topContributor(X);
    if (X.isPlayer) {
      // 【假设】原型：v0.5 兵数归零 = 本局失败（未做结算画面），这里保留少量兵继续玩
      for (const f of [...X.foes]) endPair(pairKey(X.id, f), 'player-wiped');
      ev({ type: 'player-wiped', id: X.id, by, shares, n: soldiersOf(X) });
      X.N0 = AS.player_wipe_keep_soldiers; X.raw = 0; X.brk = null; X.routed = false; X.protectUntil = s.t + CD.protect_s;
      continue;
    }
    ev({ type: 'defeat', id: X.id, cause, by, shares, n: soldiersOf(X), n0: X.N0start ?? X.N0, E: by && B[by] ? eff(by, X.id) / Math.max(1e-9, eff(X.id, by)) : 1, power0: X.N0start * X.stats.M + X.stats.genTerm });
    for (const f of [...X.foes]) endPair(pairKey(X.id, f), 'defeat');
    X.dead = true;
  }
  for (const [X] of defeated) if (X.dead) removeBody(s, X.id);

  // ---- 8) 脱离：间隙 > escape_gap_px 持续 escape_s
  const retreating = (X, Y) => X.routed || (Math.abs(angDiff(Math.atan2(Y.y - X.y, Y.x - X.x), X.h)) > AS.escaping_heading_deg * Math.PI / 180 && X.v > AS.escaping_min_speed_frac * vmax[X.id]);
  for (const [key, p] of Object.entries({ ...s.pairs })) {
    const a = B[p.a], b = B[p.b];
    const g = { gap: Math.hypot(b.x - a.x, b.y - a.y) - radiusOf(soldiersOf(a), cfg) - radiusOf(soldiersOf(b), cfg) };
    p.apartT = g.gap > MP.escape_gap_px ? +(p.apartT + dt).toFixed(6) : 0;
    if (p.apartT + 1e-9 >= MP.escape_s) {
      // 正在撤的一方 = 逃脱者（保护 protect_s）；【假设】双方都在撤 → 双方都算逃脱；都没撤（站着被拉开）→ 'apart'，没有保护
      const escs = [[a, b], [b, a]].filter(([X, Y]) => retreating(X, Y));
      endPair(key, escs.length ? 'escape' : 'apart', escs.length ? { escapers: escs.map(([X]) => X.id) } : {});
      for (const [X, Y] of escs) { X.protectUntil = s.t + CD.protect_s; ev({ type: 'escape', id: X.id, from: Y.id }); }
    }
  }

  // ---- 9) 成员变化（有人离开）→ 剩下的重算溃败线；战斗全部结束 → 结算兵数
  for (const id of changed) {
    const X = B[id]; if (!X) continue;
    if (inCombat(X)) {
      const R = ratioOf(id, allFoes), big = Math.max(R, 1 / Math.max(R, 1e-9));
      let brk = big < cfg.drawRatio ? MP.draw_break : (R > 1 ? Math.min(cfg.loserMax, cfg.loserBase + cfg.loserPer * (R - 1)) : MP.winner_break);
      X.brk = Math.max(brk, X.raw + 0.05); X.draw = big < cfg.drawRatio;
    } else if (X.brk !== null || X.raw > 0) {
      const n = soldiersOf(X), shown = roundHalfUp(n);
      ev({ type: 'combat-end', id, soldiers: shown, lost: roundHalfUp((X.N0start ?? X.N0)) - shown, routed: X.routed });
      X.N0 = shown; X.raw = 0; X.brk = null; X.draw = false; X.contrib = {}; X.ammo = unitDef(cfg, X.unit).ammo_s ?? 0;
    }
  }

  // ---- 10) 移动（加速度 / 转向速率 / 接触减速 / 溃逃失控）
  for (const id of Object.keys(B).sort()) {
    const X = B[id], u = unitDef(cfg, X.unit), vm = vmaxOf(X, cfg);
    let want = inputs[id] ?? { h: X.h, v: 0 };
    const contact = foeContact(id).length > 0;
    if (X.routed) {
      // 溃逃：自动背离最近的敌人，× rout_speed_mult；玩家 rout_control_loss_s 后恢复操控
      const near = (X.foes || []).map(f => B[f]).filter(Boolean).sort((p, q) => Math.hypot(p.x - X.x, p.y - X.y) - Math.hypot(q.x - X.x, q.y - X.y))[0];
      want = { h: near ? Math.atan2(X.y - near.y, X.x - near.x) : X.h, v: vm * MP.rout_speed_mult };
      X.routT += dt;
      if (X.routT >= MP.rout_control_loss_s) { X.routed = false; ev({ type: 'rout-recover', id }); }
    }
    let cap = (X.routed ? vm * MP.rout_speed_mult : vm) * (contact ? MP.contact_speed_mult : 1);
    let dv = Math.min(Math.max(0, want.v ?? 0), cap);
    if (dv > 1e-6) {
      const d = angDiff(want.h, X.h);
      let mx = u.turn_dps * Math.PI / 180 * dt;
      if (X.v < AS.turn_low_speed_frac * vm) mx *= 2;
      X.h = angDiff(X.h + clamp(d, -mx, mx), 0);
      dv *= Math.max(0.2, Math.cos(Math.min(Math.abs(angDiff(want.h, X.h)), Math.PI / 2)));
    }
    const acc = vm / u.accel_s * dt;
    X.v = clamp(dv, X.v - acc * 1.5, X.v + acc);
    const sp = X.v * E.speedMult(X.x, X.y);
    const nx = X.x + Math.cos(X.h) * sp * dt, ny = X.y + Math.sin(X.h) * sp * dt;
    // 分轴移动，可贴边滑动（地形由 env.fits 判断）
    let mx2 = X.x, my2 = X.y;
    if (E.fits(X, nx, my2)) mx2 = nx;
    if (E.fits(X, mx2, ny)) my2 = ny;
    if (mx2 === X.x && my2 === X.y && sp > 0) X.v = Math.min(X.v, vm * 0.3);
    X.x = mx2; X.y = my2;
  }
  // ---- 11) 【假设】任意两圆最多重叠 max_overlap_px（敌对的保持接触，但谁都不会叠在一起看不见）；各退一半，地形不允许就不退
  const OV = AS.max_overlap_px ?? 4;
  const live = Object.keys(B).sort();
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = B[live[i]], b = B[live[j]];
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), want = radiusOf(soldiersOf(a), cfg) + radiusOf(soldiersOf(b), cfg) - OV;
    if (d >= want) continue;
    const ux = d > 1e-6 ? dx / d : 1, uy = d > 1e-6 ? dy / d : 0, push = (want - d) / 2;
    const ax = a.x - ux * push, ay = a.y - uy * push, bx = b.x + ux * push, by = b.y + uy * push;
    if (E.fits(a, ax, ay)) { a.x = ax; a.y = ay; }
    if (E.fits(b, bx, by)) { b.x = bx; b.y = by; }
  }
  s.rng = rng.getState();
  return s;
}

/** 把 balance（v0.4 battle 段）和 combat_v05.json 合成 step 用的 cfg */
export function makeCombatConfig(combatJson, balance) {
  const bt = balance.battle;
  return {
    ...combatJson,
    rollMin: bt.random_min, rollMax: bt.random_max, drawRatio: bt.draw_ratio,
    loserBase: bt.loser_loss_base, loserPer: bt.loser_loss_per_ratio, loserMax: bt.loser_loss_max
  };
}
