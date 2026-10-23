/**
 * 队伍数据模型（纯函数，无 Phaser 依赖，可在 node 中测试）。
 * team 结构 = balance.team_example：
 *   { id, faction, is_player, soldiers, generals: [{id, name, lead, str, int, cha}], items: [itemId], position: {x,y}, state }
 * 程序扩展字段：name（按 team_name_rule 生成）、home（游荡中心）。
 * 初始队伍来自 balance.initial_teams；generals 写法："hero" / 名将 id / "generic"（按阵营 generic_general 随机）。
 */
import { randInt } from './rng.js';
import { roundHalfUp } from './combat.js';
import { getLeader, leaderLead, recalcLeader } from './leader.js';

const ATTRS = ['lead', 'str', 'int', 'cha'];

export function indexBalance(balance) {
  const generalsById = Object.fromEntries(balance.generals.map(g => [g.id, g]));
  if (balance.hero) generalsById[balance.hero.id] = balance.hero;
  return {
    generalsById,
    itemsById: Object.fromEntries(balance.items.map(i => [i.id, i])),
    factionsById: Object.fromEntries(balance.ai.factions.map(f => [f.id, f]))
  };
}

/** 黄巾头目名字分配：bandit_name_pool 不放回抽取，池空后用「黄巾头目N」 */
export function createNameAllocator(balance, rng) {
  let pool = [...(balance.ai.bandit_name_pool || [])];
  let n = 0;
  const next = () => {
    if (pool.length) return pool.splice(Math.floor(rng() * pool.length), 1)[0];
    return `黄巾头目${++n}`;
  };
  /** 存档：剩余名字池 + 已用的「黄巾头目N」序号 */
  next.getState = () => ({ pool: [...pool], n });
  next.setState = (s) => { pool = [...s.pool]; n = s.n; };
  next.reset = () => { pool = [...(balance.ai.bandit_name_pool || [])]; n = 0; };
  return next;
}

/** 队伍名：玩家 = player_faction.team_name；其余按阵营 team_name_rule（{主将名} = v0.6 统帅名 / {头目名}） */
export function teamName(team, balance, idx) {
  if (team.is_player) return balance.player_faction?.team_name ?? '主角军';
  const rule = idx.factionsById[team.faction]?.team_name_rule ?? '{主将名}军';
  const main = getLeader(team, balance); // v0.6：{统帅名}军（名将军 = 名将）
  return rule.replace('{主将名}', main?.name ?? team.id).replace('{头目名}', main?.name ?? team.id);
}

function resolveGeneral(ref, team, idx, rng, nextName) {
  if (ref === 'generic' || ref?.generic) {
    const f = idx.factionsById[team.faction];
    const ranges = f && f.generic_general;
    if (!ranges) throw new Error(`阵营 ${team.faction} 没有 generic_general 配置`);
    const g = { id: `${team.id}_gen`, name: ref.name || nextName(), generic: true };
    for (const a of ATTRS) g[a] = ref[a] ?? randInt(rng, ranges[a][0], ranges[a][1]);
    return g;
  }
  if (typeof ref === 'object' && ref.id === undefined) { // 内联武将（worked_examples 用）
    return { id: ref.name, generic: true, ...ref };
  }
  const id = typeof ref === 'string' ? ref : ref.id;
  const base = idx.generalsById[id];
  if (!base) throw new Error(`未知武将 id: ${id}`);
  const g = { id: base.id, name: base.name };
  if (base.tier !== undefined) g.tier = base.tier; // 主角没有档位：不写 undefined 字段（存档 JSON 往返保持一致）
  for (const a of ATTRS) g[a] = (typeof ref === 'object' ? ref[a] : undefined) ?? base[a];
  return g;
}

/**
 * 由 initial_teams 风格定义构建完整 team，并做配置校验（返回 {team, warnings}）
 * position 可为 {x,y} 或 "home"（阵营 home）。
 */
export function buildTeam(def, balance, rng, idx = indexBalance(balance), nextName = createNameAllocator(balance, rng)) {
  const rules = balance.team_rules;
  const warnings = [];
  const isPlayer = def.is_player ?? def.faction === (balance.player_faction?.id ?? 'player');
  const fac = idx.factionsById[def.faction];
  let position = def.position;
  if (position === 'home') position = fac?.home;
  if (!position) { warnings.push(`${def.id}: 没有位置`); position = { x: 0, y: 0 }; }
  const team = {
    id: def.id, faction: def.faction, is_player: isPlayer, soldiers: def.soldiers,
    generals: [], items: [...(def.items || [])], position: { ...position }, state: def.state || 'wander'
  };
  team.generals = (def.generals || []).map(ref => resolveGeneral(ref, team, idx, rng, nextName));
  if (def.name) team.fixedName = true;
  recalcLeader(team, balance);
  team.name = def.name || teamName(team, balance, idx);
  // home：阵营 home；黄巾（home=null）= 出生点；玩家 = 起点
  team.home = { ...(fac?.home ?? position) };
  if (team.generals.length === 0) warnings.push(`${team.id}: 没有武将`);
  if (team.generals.length > rules.max_generals) warnings.push(`${team.id}: 武将数 > max_generals ${rules.max_generals}`);
  if (team.items.length > rules.item_slots) warnings.push(`${team.id}: 物品数 > item_slots ${rules.item_slots}`);
  for (const it of team.items) if (!idx.itemsById[it]) warnings.push(`${team.id}: 未知物品 ${it}`);
  return { team, warnings };
}

/** 自由池：不在任何队伍中的名将 id（initial_free_pool 起步） */
export function initialFreePool(balance) { return [...(balance.initial_free_pool || [])]; }

/**
 * 补充刷新队伍（balance.spawn）：
 *   P* = 玩家面板战力 × U(power_vs_player)；先随机头目属性，再
 *   N = min(兵力上限, max(min_soldiers, round((P* − k_gen×Σ武力) / M)))，M = 1 + k_lead×统帅统率 + k_str×Σ武力 + 物品%
 */
export function buildRespawnTeam({ id, position, playerPower, balance, rng, idx = indexBalance(balance), nextName, powerRange = null }) {
  const sp = balance.spawn;
  const def = { id, faction: sp.faction, soldiers: 1, generals: ['generic'], items: [], position };
  const { team } = buildTeam(def, balance, rng, idx, nextName);
  const [lo, hi] = powerRange ?? sp.power_vs_player; // v0.5：按章节（chapters.spawn_power_vs_player）
  const target = playerPower * (lo + rng() * (hi - lo));
  const p = balance.power, g = team.generals;
  const sumStr = g.reduce((s, x) => s + x.str, 0);
  const lead = leaderLead(team, balance);
  const M = 1 + p.k_lead * lead + p.k_str * sumStr;
  const cap = balance.team_rules.soldier_cap_base + balance.team_rules.soldier_cap_per_lead * g.reduce((s, x) => s + x.lead, 0);
  team.soldiers = Math.min(cap, Math.max(sp.min_soldiers, roundHalfUp((target - p.k_gen * sumStr) / M)));
  team.targetPower = target;
  return team;
}

/**
 * tuning_r1 T2（stale_refresh）：场上已满 max_ai_teams 时，挑 1 支要撤下的『过弱普通黄巾队』，腾位按当前章节重刷。
 * 条件：势力 = stale_refresh.faction（id 或名字）、战力 < stale_ratio × 玩家战力、不在交战、距玩家 > min_dist_px；
 * 不含来袭（raid）、守军（cityHold）、攻城队（siegeTarget）、名将军（namedIds）、校尉军（refill）。
 * 多支符合 → 战力最低的（同战力按 id），保证确定性。没开 / 没有符合的 → null。纯函数。
 */
export function pickStaleTeam(parties, player, balance, { namedIds = new Set() } = {}) {
  const S = balance.v06?.tuning?.stale_refresh;
  if (!S?.enabled || !player) return null;
  const fac = S.faction ?? '黄巾';
  const facOk = f => f === fac || balance.ai?.factions?.find(x => x.id === f)?.name === fac;
  const c = parties.filter(p => facOk(p.faction) && !p.isPlayer && !p.inBattle && !p.team?.raid && !p.team?.cityHold && !p.team?.siegeTarget
    && !p.team?.refill && !namedIds.has(p.id) && !String(p.id).startsWith('refill_')
    && p.power < S.stale_ratio * player.power && Math.hypot(p.x - player.x, p.y - player.y) > S.min_dist_px);
  c.sort((a, b) => a.power - b.power || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return c[0] ?? null;
}
