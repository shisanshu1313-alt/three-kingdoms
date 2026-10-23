/**
 * v0.6 城池（city_v06，纯逻辑，无 Phaser；单测 tests/city_v06.test.js）。全部数字读 balance.v06.city。
 *
 * 城 = 固定的圆（radius_px 48）；城内 = 距城心 ≤ inside_px（60）；攻城 = 队伍圆和城圆接触。
 * state.cities = { id: { id, name, x, y, owner, def, defCh, lastHitS, zeroAtS, hold, lostHold, garrison, declined } }
 *   owner：'player'（玩家主城）| 势力 id（敌方大本营）| null（无主城）；garrison：守军势力（洛阳开局 'bandit'），守军队伍被消灭后清空
 *
 *   createCities(balance, {garrison})       开局（洛阳有黄巾守军；旧存档迁移时 garrison=false）
 *   citySide(city)                          城的归属方（owner ?? 守军势力 ?? null）
 *   protectingCity(p, cities, balance)      p 在自己一方城防 > 0 的城里（≤ inside_px）→ 受保护（不能被攻击，也不能攻击城外）
 *   cityTick(cities, parties, ctx)          攻城伤害 / 城上弓箭 / 回复 / 城破窗口 / 占城计时 / 失守计时 → { events, losses }
 *   applyChapter(cities, ch, balance)       换章：城防上限换新、当前城防按比例放大
 *   capture / loseCity / relocate           占城（立为主城 / 迁都）、失守（无主城 30%，存放的武将回自由池）
 */
import { loseStore } from './roster.js';

const C6 = balance => {
  const c = balance.v06?.city;
  if (!c) throw new Error('缺少 v0.6 城池配置（balance.v06.city）');
  return c;
};
const chi = (arr, ch) => arr[Math.max(0, Math.min(arr.length - 1, ch | 0))];
export const defMax = (balance, ch) => chi(C6(balance).def_by_chapter, ch);
export const PLAYER = 'player';

export function createCities(balance, { chapter = 0, garrison = true } = {}) {
  const C = C6(balance), out = {};
  for (const c of balance.cities) {
    const owner = C.capitals[c.id] ?? null;
    const g = garrison && C.garrison?.city === c.id ? C.garrison.faction : null;
    out[c.id] = { id: c.id, name: c.name, x: c.px.x, y: c.px.y, owner, def: defMax(balance, chapter), defCh: chapter,
      lastHitS: -1e9, zeroAtS: null, hold: 0, lostHold: 0, garrison: g, declined: false };
  }
  return out;
}

export const citySide = city => city.owner ?? city.garrison ?? null;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** p = {x, y, faction}；返回保护它的城（没有 = null） */
export function protectingCity(p, cities, balance) {
  if (!cities) return null;
  const C = C6(balance);
  for (const c of Object.values(cities)) if (c.def > 0 && citySide(c) === p.faction && dist(p, c) <= C.inside_px) return c;
  return null;
}
/** 能否新开战：任一方受城保护 → 不能（城防 > 0 时城里的队伍不能被攻击，也不能攻击城外） */
export const noEngage = (a, b, cities, balance) => !!(protectingCity(a, cities, balance) || protectingCity(b, cities, balance));

/** 敌对：城有归属方时 = 势力不同；无主空城只有玩家会攻（为了占城） */
/** 势力之间是否敌对（战场和城上弓箭共用一个口径；目前没有同盟系统 = 势力不同即敌对） */
export const factionsHostile = (fa, fb) => fa !== fb;
/** 【策划 2026-10-23 #4】城上弓箭只射与城主敌对的队伍；友军 / 同盟路过不射。hostile = 势力敌对判定（默认 factionsHostile） */
export function hostileToCity(p, city, hostile = factionsHostile) {
  const side = citySide(city);
  return side ? hostile(p.faction, side) : !!p.isPlayer;
}
export const inContact = (p, city, balance) => dist(p, city) <= C6(balance).radius_px + (p.r ?? 0);

/** 每秒城防伤害 = dmg_k × 攻方战力 × 兵种攻城倍率 */
export const siegeDps = (power, unit, balance) => C6(balance).dmg_k * power * (C6(balance).unit_siege_mult[unit] ?? 1);

/**
 * 城上弓箭：按 v0.5 弓兵射击公式，射手战力 = arrow_power_k × 本章参考战力；
 * 每秒损兵比例 = min(rate_cap, lam × (射手/目标)^a) × 弓兵 shoot_mult × 目标兵种 arrow_taken（步兵 0.6）× 克制物品减伤
 */
export function arrowRate(target, ch, balance, mv) {
  const C = C6(balance), shooter = C.arrow_power_k * chi(C.arrow_ref_power, ch);
  const ratio = shooter / Math.max(1e-9, target.power);
  const arc = mv.units.arc, tu = mv.units[target.unit] ?? {};
  const taken = 1 - Math.min(0.9, target.takenFrom?.arc ?? 0);
  return Math.min(mv.rate_cap, mv.lam * Math.pow(ratio, mv.a)) * (arc.shoot_mult ?? 1) * (tu.arrow_taken ?? 1) * taken;
}

/** 能占：无主、守军已消灭、不是自己的主城、没有因拒绝迁都而等待离开 */
export const capturable = (city, homeCity) => city.owner == null && !city.garrison && city.id !== homeCity;

/**
 * 一个固定 tick。
 * parties：[{ id, x, y, r, faction, unit, power, soldiers, isPlayer, siegeTarget, takenFrom }]
 * ctx：{ tS, dt, chapter, balance, move（combat_v05.move）, homeCity }
 * 返回 { events: [{type:'breached'|'capture_ready'|'lost'|'regen', city}], losses: { partyId: 损兵（小数） } }
 */
export function cityTick(cities, parties, ctx) {
  const { tS, dt, chapter, balance, move, homeCity } = ctx, C = C6(balance), events = [], losses = {};
  const max = defMax(balance, chapter);
  for (const c of Object.values(cities)) {
    const hostile = parties.filter(p => hostileToCity(p, c, ctx.hostile) && inContact(p, c, balance));
    // 城上弓箭（城防 > 0 且城有归属方）：打所有接触城、且与城主敌对的队伍（友军 / 同盟路过不射）
    if (c.def > 0 && citySide(c)) for (const p of hostile) losses[p.id] = (losses[p.id] ?? 0) + arrowRate(p, chapter, balance, move) * p.soldiers * dt;
    // 攻城：玩家打任何敌对的城；AI 只打它的攻城目标（路过的不算）
    const sieging = hostile.filter(p => p.isPlayer || p.siegeTarget === c.id);
    if (sieging.length) {
      c.lastHitS = tS;
      if (c.def > 0) {
        c.def -= sieging.reduce((s, p) => s + siegeDps(p.power, p.unit, balance), 0) * dt;
        if (c.def <= 0) { c.def = 0; c.zeroAtS = tS; events.push({ type: 'breached', city: c }); }
      }
    } else if (c.def < max && tS - c.lastHitS >= C.regen_idle_s && (c.zeroAtS == null || tS - c.zeroAtS >= C.break_window_s)) {
      c.def = Math.min(max, c.def + C.regen_pct_per_s * max * dt);
      if (c.def > 0) c.zeroAtS = null;
    }
    // 占城：城防 0 → 守军已灭 → 玩家在城心 capture_inside_px 内停 capture_hold_s
    const pl = parties.find(p => p.isPlayer);
    const plIn = pl && dist(pl, c) <= C.capture_inside_px;
    if (c.declined && !plIn) c.declined = false;
    if (pl && c.def === 0 && capturable(c, homeCity) && plIn && !c.declined) {
      c.hold += dt;
      if (c.hold >= C.capture_hold_s) { c.hold = 0; events.push({ type: 'capture_ready', city: c }); }
    } else c.hold = 0;
    // 失守：玩家主城城防 0 且敌队在城内停 lost_hold_s
    if (c.owner === PLAYER && c.def === 0 && parties.some(p => !p.isPlayer && p.faction !== PLAYER && dist(p, c) <= C.inside_px)) {
      c.lostHold += dt;
      if (c.lostHold >= C.lost_hold_s) { c.lostHold = 0; events.push({ type: 'lost', city: c }); }
    } else c.lostHold = 0;
  }
  return { events, losses };
}

/** 换章：上限换新，当前城防按比例放大 */
export function applyChapter(cities, ch, balance) {
  for (const c of Object.values(cities ?? {})) {
    const from = defMax(balance, c.defCh ?? 0), to = defMax(balance, ch);
    if (from !== to) c.def = c.def * to / from;
    c.defCh = ch;
  }
}

/** 敌方大本营：势力被讨伐后变成无主城（城防不变） */
export function freeConqueredCapitals(cities, conquered) {
  const out = [];
  for (const c of Object.values(cities ?? {})) if (c.owner && c.owner !== PLAYER && conquered.has(c.owner)) { c.owner = null; out.push(c); }
  return out;
}

/** 立为主城（relocate = 迁都：旧主城变回无主城，存放的武将跟着走） */
export function capture(state, cityId) {
  const c = state.cities[cityId], old = state.homeCity ? state.cities[state.homeCity] : null;
  if (old) old.owner = null;
  c.owner = PLAYER; c.garrison = null; c.hold = 0; c.declined = false;
  state.homeCity = cityId;
  return { city: c, old };
}
/** 拒绝迁都：等玩家离开城心再重新计时 */
export function decline(state, cityId) { const c = state.cities[cityId]; c.declined = true; c.hold = 0; }

/** 主城失守：变回无主城（城防 lost_def_ratio × 上限），存放的武将回自由池 */
export function loseCity(state, cityId, balance, chapter) {
  const c = state.cities[cityId];
  c.owner = null; c.def = C6(balance).lost_def_ratio * defMax(balance, chapter); c.zeroAtS = null; c.lostHold = 0;
  if (state.homeCity === cityId) state.homeCity = null;
  return { city: c, lostGenerals: loseStore(state) };
}

/** 回血 / 补兵 / 整编能用的城（service_cities = own_or_neutral）：自己主城 + 无主且没有守军的城 */
export function serviceCity(city) { return city.owner === PLAYER || (city.owner == null && !city.garrison); }

/** 最近的城（和距离） */
export function nearestCity(p, cities) {
  let best = null, bd = Infinity;
  for (const c of Object.values(cities ?? {})) { const d = dist(p, c); if (d < bd) { bd = d; best = c; } }
  return best ? { city: best, d: bd } : null;
}

// ---------------- AI 攻城（city_v06.ai）----------------
/**
 * 玩家在主城里连续待满 hold_s（第 from_chapter 章起）且距上次派兵 ≥ cooldown_s → 该派兵了。
 * runCity = run.city（随存档）：{ insideS, lastDispatchS, emptyAcc }
 */
export function siegePlayerDue(runCity, { inside, tS, dt, chapter }, balance) {
  const A = C6(balance).ai_siege_player;
  // 【策划 2026-10-23 #8】from_chapter（第 2 章）之前在城里的时间不算：计时一直是 0，进入第 2 章从 0 开始；
  // 之后连续在城 hold_s 秒才派兵，出城清零
  if (chapter + 1 < A.from_chapter) { runCity.insideS = 0; return false; }
  runCity.insideS = inside ? (runCity.insideS ?? 0) + dt : 0;
  if (runCity.insideS < A.hold_s) return false;
  if (tS - (runCity.lastDispatchS ?? -1e9) < A.cooldown_s) return false;
  runCity.lastDispatchS = tS;
  return true;
}
/** 空城被攻：第 from_chapter 章起，玩家离主城 > away_px 时每满 60 s 掷一次 chance_per_min */
export function siegeEmptyDue(runCity, { away, dt, chapter }, balance, rng) {
  const E = C6(balance).ai_siege_empty;
  if (chapter + 1 < E.from_chapter || !away) { runCity.emptyAcc = 0; return false; }
  runCity.emptyAcc = (runCity.emptyAcc ?? 0) + dt;
  const P = C6(balance).empty_siege_roll_s ?? 60;
  if (runCity.emptyAcc < P) return false;
  runCity.emptyAcc -= P;
  return rng() < E.chance_per_min;
}
/**
 * 选派兵：离主城最近的、没被讨伐的势力（按大本营距离）里，战力 ≥ min_ratio × 玩家的野外队（离主城最近）；
 * 没有 → { spawn: faction }（调用方在 spawn_dist_px 处刷一支 spawn_ratio 倍的讨伐军）。
 * teams：[{ id, faction, power, x, y, named, garrison, inBattle, siegeTarget }]
 */
export function pickSiegeTeam(city, teams, playerPower, conquered, balance) {
  const A = C6(balance).ai_siege_player;
  const facs = Object.entries(C6(balance).capitals).map(([cid, f]) => ({ f, d: dist(balance.cities.find(x => x.id === cid).px, city) }))
    .filter(x => !conquered.has(x.f)).sort((a, b) => a.d - b.d);
  if (!facs.length) return null;
  const f = facs[0].f;
  const cands = teams.filter(t => t.faction === f && !t.named && !t.garrison && !t.inBattle && !t.siegeTarget && t.power >= A.min_ratio * playerPower)
    .sort((a, b) => dist(a, city) - dist(b, city));
  return cands.length ? { team: cands[0], faction: f } : { spawn: f };
}
/** 空城被攻：离主城最近的敌队（不含名将军、守军、交战中、已在攻城的） */
export function pickNearbyTeam(city, teams) {
  const c = teams.filter(t => !t.named && !t.garrison && !t.inBattle && !t.siegeTarget).sort((a, b) => dist(a, city) - dist(b, city));
  return c[0] ?? null;
}
