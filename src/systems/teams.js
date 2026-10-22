/**
 * 队伍数据模型（纯函数，无 Phaser 依赖，可在 node 中测试）。
 * team 结构 = balance.team_example：
 *   { id, faction, is_player, soldiers, generals: [{id, name, lead, str, int, cha}], items: [itemId], position: {x,y}, state }
 * 程序扩展字段：name（按 team_name_rule 生成）、home（游荡中心）。
 * 初始队伍来自 balance.initial_teams；generals 写法："hero" / 名将 id / "generic"（按阵营 generic_general 随机）。
 */
import { randInt } from './rng.js';

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
  const pool = [...(balance.ai.bandit_name_pool || [])];
  let n = 0;
  return () => {
    if (pool.length) return pool.splice(Math.floor(rng() * pool.length), 1)[0];
    return `黄巾头目${++n}`;
  };
}

/** 队伍名：玩家 = player_faction.team_name；其余按阵营 team_name_rule（{主将名} / {头目名}） */
export function teamName(team, balance, idx) {
  if (team.is_player) return balance.player_faction?.team_name ?? '主角军';
  const rule = idx.factionsById[team.faction]?.team_name_rule ?? '{主将名}军';
  const main = team.generals[balance.team_rules.main_general_index] ?? team.generals[0];
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
  const g = { id: base.id, name: base.name, tier: base.tier };
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
 *   N = min(兵力上限, max(min_soldiers, round((P* − k_gen×Σ武力) / M)))，M = 1 + k_lead×主将统率 + k_str×Σ武力 + 物品%
 */
export function buildRespawnTeam({ id, position, playerPower, balance, rng, idx = indexBalance(balance), nextName }) {
  const sp = balance.spawn;
  const def = { id, faction: sp.faction, soldiers: 1, generals: ['generic'], items: [], position };
  const { team } = buildTeam(def, balance, rng, idx, nextName);
  const [lo, hi] = sp.power_vs_player;
  const target = playerPower * (lo + rng() * (hi - lo));
  const p = balance.power, g = team.generals;
  const sumStr = g.reduce((s, x) => s + x.str, 0);
  const lead = g[balance.team_rules.main_general_index].lead;
  const M = 1 + p.k_lead * lead + p.k_str * sumStr;
  const cap = balance.team_rules.soldier_cap_base + balance.team_rules.soldier_cap_per_lead * g.reduce((s, x) => s + x.lead, 0);
  team.soldiers = Math.min(cap, Math.max(sp.min_soldiers, Math.round((target - p.k_gen * sumStr) / M)));
  team.targetPower = target;
  return team;
}
