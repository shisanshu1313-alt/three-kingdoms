/**
 * v0.6 城池（city_v06，纯逻辑，无 Phaser；单测 tests/city_v06.test.js）。全部数字读 balance.v06.city。
 *
 * 城 = 固定的圆（radius_px 48）；城内 = 距城心 ≤ inside_px（60）；攻城 = 队伍圆和城圆接触。
 * state.cities = { id: { id, name, x, y, owner, def, defCh, lastHitS, zeroAtS, zeroAwayS, hold, lostHold, garrison, declined } }
 *   owner：'player'（玩家主城）| 势力 id（敌方大本营）| null（无主城）；garrison：守军势力（洛阳开局 'bandit'），守军队伍被消灭后清空
 *
 *   createCities(balance, {garrison})       开局（洛阳有黄巾守军；旧存档迁移时 garrison=false）
 *   citySide(city)                          城的归属方（owner ?? 守军势力 ?? null）
 *   protectingCity(p, cities, balance)      p 在自己一方城防 > 0 的城里（≤ inside_px）→ 受保护（不能被攻击，也不能攻击城外）
 *   cityTick(cities, parties, ctx)          攻城伤害 / 城上弓箭 / 回复 / 城破窗口 / 占城计时 / 失守计时 → { events, losses }
 *   applyChapter(cities, ch, balance)       换章：城防上限换新；chapter_change 'keep' = 当前城防不变（满城防 → 新上限）
 *   capture / loseCity / relocate           占城（立为主城 / 迁都）、失守（无主城 30%，存放的武将回自由池）
 */
import { loseStore } from './roster.js';
import { computePower, soldierCap, roundHalfUp } from './combat.js';

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

/** tuning_r1 T1：每秒城防伤害上限 = 该章城防上限 / siege_min_s（满城防打到 0 至少 siege_min_s 秒）；siege_min_s 缺省 / 0 = 不限 */
export function siegeDpsCapped(dps, defMaxNow, balance) {
  const m = balance.v06?.tuning?.siege_min_s;
  return m > 0 ? Math.min(dps, defMaxNow / m) : dps;
}

/** tuning_r1 T4（needs_user，garrison_power_floor.enabled 默认 false）：守军战力 = max(floor, power_vs_player × 玩家战力)，
 *  返回给 buildRespawnTeam 用的『玩家战力』（再乘 power_vs_player）；关着 = 原样 */
export function garrisonBasePower(playerPower, balance) {
  const F = balance.v06?.tuning?.garrison_power_floor, k = C6(balance).garrison.power_vs_player;
  return F?.enabled ? Math.max(playerPower, F.value / k) : playerPower;
}

/** T4：守军目标战力 = max(garrison_power_floor, power_vs_player × 玩家战力)；关掉 T4 = power_vs_player × 玩家 */
export function garrisonTargetPower(playerPower, balance) {
  const F = balance.v06?.tuning?.garrison_power_floor, k = C6(balance).garrison.power_vs_player;
  return F?.enabled ? Math.max(F.value, k * playerPower) : k * playerPower;
}

/** 让该队（武将 / 物品不变）面板战力 ≥ target 的最少兵数（向上取整，至少 1，不超过兵力上限）。纯函数 */
export function garrisonFullSoldiers(team, target, balance) {
  const b = computePower({ ...team, soldiers: 0 }, balance), m = computePower({ ...team, soldiers: 1 }, balance) - b;
  return Math.min(soldierCap(team, balance), Math.max(1, Math.ceil((target - b) / Math.max(1e-9, m) - 1e-9)));
}

/** city_v06.garrison.power_recalc 存在（sync → recalc = 'battle_start'）：每次开战前按当时玩家战力重算 */
export const garrisonRecalcOn = balance => balance.v06?.tuning?.garrison_power_floor?.recalc === 'battle_start';

/**
 * T4 + power_recalc（策划 2026-10-23）：按当前玩家战力重算守军兵数，交战中不要调用（WorldScene 只在守军不在交战时调）。
 * 之前的损失按比例保留、不补满：team.soldiers 和上次重算后的 garrisonN 不同 = 打过仗掉了兵 → garrisonKeep = soldiers / garrisonFull（上次满编）。
 * 新兵数 = 新满编 × garrisonKeep（四舍五入，至少 1）；garrisonKeep = 1 时正好满编（战力 ≥ 目标）。
 * 刚出生 / 旧存档没有这些字段：按出生时的目标战力 team.targetPower 估满编算比例（差 ≤ 1 个兵算满编）。改 team，返回 team。纯函数（无随机）。
 */
export function garrisonRecalc(team, playerPower, balance) {
  if (team.garrisonN == null) {
    // 刚出生（buildRespawnTeam 四舍五入，最多少 1 个兵）或旧存档：和出生目标战力的满编比；差 ≤ 1 个兵算满编
    if (team.garrisonKeep == null && team.targetPower != null) {
      const f0 = garrisonFullSoldiers(team, team.targetPower, balance);
      team.garrisonKeep = team.soldiers >= f0 - 1 ? 1 : team.soldiers / f0;
    }
  } else if (team.soldiers !== team.garrisonN && team.garrisonFull > 0) team.garrisonKeep = Math.min(1, team.soldiers / team.garrisonFull);
  const keep = team.garrisonKeep ?? 1, full = garrisonFullSoldiers(team, garrisonTargetPower(playerPower, balance), balance);
  team.garrisonFull = full;
  team.soldiers = keep >= 1 ? full : Math.max(1, roundHalfUp(full * keep));
  team.garrisonN = team.soldiers;
  return team;
}

/**
 * T4 power_recalc 开战回调（WorldScene 传给 melee.step 的 env.engageSoldiers）：玩家队和洛阳守军开战的那一刻，
 * 守军兵数 = 按当时玩家战力重算的满编 × remain_frac。不改原队（只算数），onEngage 里再对真队伍 garrisonRecalc（结果相同）。
 * garrisonTeam 不是守军 / 对手不是玩家 / 没开 recalc / 守军已在交战（第三方加入）→ null（不改）。
 */
export function garrisonEngageSoldiers(garrisonTeam, foeIsPlayer, playerPower, balance) {
  if (!garrisonRecalcOn(balance) || !garrisonTeam?.cityHold || !foeIsPlayer) return null;
  return garrisonRecalc({ ...garrisonTeam }, playerPower, balance).soldiers;
}

/**
 * 标签用（不在交战）：max(70, 0.5 × 当前玩家战力) × remain_frac（策划 power_recalc.label；label_applies_ratio = false 时不乘）。不改原队。
 * remain_frac = 当前兵数 / 上次重算的满编（累计，初始 1）。返回值按兵数取整后的面板战力（开战瞬间与实际守军相等）。
 */
export function garrisonPreviewPower(team, playerPower, balance) {
  const F = balance.v06?.tuning?.garrison_power_floor;
  const t = { ...team };
  if (F?.label_applies_ratio === false) { t.garrisonKeep = 1; t.garrisonN = null; t.targetPower = null; }
  return computePower(garrisonRecalc(t, playerPower, balance), balance);
}

/**
 * 城名下方的标签（WorldScene.drawCities 用；纯函数便于单测）。
 * T4：有守军的城显示「守军战力 N」；守军比玩家强 → 标红并注明「强于你」（策划 T4 mitigation：玩家战力 < 守军时提示）。
 * opts：{ max, factionName, storeText, garrisonPower（守军队伍当前战力，没有 = null）, playerPower, strongerHint（city.garrison.stronger_hint，默认 'gt'）}
 */
export function cityLabel(c, { max, factionName = null, storeText = '', garrisonPower = null, playerPower = 0, strongerHint = 'gt' }) {
  const side = citySide(c);
  const owner = c.owner === PLAYER ? '我的主城' : c.owner ? `${factionName ?? c.owner}大本营` : c.garrison ? '黄巾守军' : '无主城';
  const gp = c.garrison && garrisonPower != null ? Math.round(garrisonPower) : null;
  // 策划 power_recalc.stronger_hint = 'gt'：标签战力 > 玩家战力（严格大于）才提示，相等不提示；按显示出来的整数比（玩家战力 HUD 也显示整数）
  const pp = Math.round(playerPower), strong = gp != null && (strongerHint === 'gte' ? gp >= pp : gp > pp);
  const gText = gp != null ? `  守军战力 ${gp}${strong ? '（强于你）' : ''}` : '';
  const text = `${owner}  城防 ${Math.ceil(c.def)}/${max}${c.def <= 0 ? '（已破）' : ''}${gText}${storeText}`;
  return { text, color: side === PLAYER ? '#aaffaa' : strong ? '#ff7777' : '#ffffff' };
}

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

/** 城破窗口是否已过：regen_rule 'away' = 玩家离开（不贴城、不和守军交战）连续满 break_window_s；'since_zero' = 旧规则，从归零起算 */
export function breakWindowOver(c, tS, held, C) {
  if (c.def > 0) return true;
  if (C.regen_rule === 'away') return !held && (c.zeroAwayS ?? 0) >= C.break_window_s;
  return c.zeroAtS == null || tS - c.zeroAtS >= C.break_window_s;
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
    // 策划 siege.regen_rule（'away'）：城防为 0 时，有攻城方贴着城（玩家贴着敌对 / 无主城就算）或玩家正在和这座城的守军交战 → 回复倒计时暂停并清零；
    // 都没有 → 累计「离开」时间 zeroAwayS，满 break_window_s 才开始回复（回复后城防 > 0，要重新破城）
    const held = sieging.length > 0 || !!ctx.playerFightingGarrison?.includes?.(c.id);
    if (c.def <= 0) c.zeroAwayS = held ? 0 : (c.zeroAwayS ?? 0) + dt;
    if (sieging.length) {
      c.lastHitS = tS;
      if (c.def > 0) {
        c.def -= siegeDpsCapped(sieging.reduce((s, p) => s + siegeDps(p.power, p.unit, balance), 0), max, balance) * dt;
        if (c.def <= 0) { c.def = 0; c.zeroAtS = tS; c.zeroAwayS = 0; events.push({ type: 'breached', city: c }); }
      }
    } else if (c.def < max && tS - c.lastHitS >= C.regen_idle_s && breakWindowOver(c, tS, held, C)) {
      c.def = Math.min(max, c.def + C.regen_pct_per_s * max * dt);
      if (c.def > 0) { c.zeroAtS = null; c.zeroAwayS = 0; }
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

/**
 * 换章：城防上限换成新章的（每秒城防伤害上限在 cityTick 里按当前章上限 ÷ siege_min_s 算，换章那一 tick 立即生效）。
 * 策划 siege.chapter_change = 'keep'：当前城防值不变、不按新章上限补满（之后照常按新上限的 3%/s 回复）；
 * 【解读】满城防（没被打过 / 已回满）的城仍算满城防 → 设为新章上限。'scale'（旧版）：按比例放大。
 */
export function applyChapter(cities, ch, balance) {
  const mode = C6(balance).chapter_change ?? 'scale';
  for (const c of Object.values(cities ?? {})) {
    const from = defMax(balance, c.defCh ?? 0), to = defMax(balance, ch);
    if (from !== to) c.def = mode === 'keep' ? (c.def >= from - 1e-9 ? to : c.def) : c.def * to / from;
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
/** 【策划 2026-10-23】city.raid_exclude（势力名或 id，默认 ["黄巾"]）：这些势力不来攻玩家主城（20 s 派兵、趁虚攻打都不派） */
export function raidExcluded(faction, balance) {
  const ex = C6(balance).raid_exclude ?? ['黄巾'];
  const name = balance.ai?.factions?.find(f => f.id === faction)?.name;
  return ex.includes(faction) || (name != null && ex.includes(name));
}
export function pickSiegeTeam(city, teams, playerPower, conquered, balance) {
  const A = C6(balance).ai_siege_player;
  const facs = Object.entries(C6(balance).capitals).map(([cid, f]) => ({ f, d: dist(balance.cities.find(x => x.id === cid).px, city) }))
    .filter(x => !conquered.has(x.f) && !raidExcluded(x.f, balance)).sort((a, b) => a.d - b.d);
  if (!facs.length) return null;
  const f = facs[0].f;
  const cands = teams.filter(t => t.faction === f && !t.named && !t.garrison && !t.inBattle && !t.siegeTarget && t.power >= A.min_ratio * playerPower)
    .sort((a, b) => dist(a, city) - dist(b, city) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return cands.length ? { team: cands[0], faction: f } : { spawn: f };
}
/** 空城被攻：离主城最近的敌队（不含名将军、守军、交战中、已在攻城的、raid_exclude 的势力（黄巾）） */
export function pickNearbyTeam(city, teams, balance) {
  const c = teams.filter(t => !t.named && !t.garrison && !t.inBattle && !t.siegeTarget && !(balance && raidExcluded(t.faction, balance)))
    .sort((a, b) => dist(a, city) - dist(b, city) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return c[0] ?? null;
}
