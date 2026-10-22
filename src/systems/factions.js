/**
 * v0.5 势力相关的一局规则（纯函数，无 Phaser；配置 run_v05.json ← balance_v0.5.json polish_merged）：
 *   - 名将军补兵（4_named_reinforce）：名将军每满 1 分钟 +per_min 兵（按 20/时长 缩放），不超过兵力上限；
 *     【解读】战斗中不补（实时战斗里改兵数会打乱伤害计算），脱战后把欠下的整分钟一次补上
 *   - 势力补队（3_faction_refill）：魏蜀吴群没被讨伐、且场上没有该势力的队伍 → 下一次刷新改为在其大本营刷一支「校尉军」：
 *     武将统武 60–80、智魅 40–70，兵种 = 势力兵种（名将军的兵种），战力 = max(120, 玩家战力) × U(0.8, 1.2)
 *   - 讨伐：击败名将军（玩家有伤害份额）才算；【假设】名将军被别的 AI 打掉后，击败该势力的校尉军也算（否则无法通关）
 */
import { randInt } from './rng.js';
import { mainGeneral, roundHalfUp } from './combat.js';

/** 名将军 id → 势力（来自 initial_teams） */
export function namedFactions(balance, run) {
  const out = {};
  for (const id of run.run_goal.named) { const t = balance.initial_teams.find(x => x.id === id); if (t) out[id] = t.faction; }
  return out;
}

/** 已讨伐的势力 */
export function conqueredFactions(runState, balance, run) {
  const nf = namedFactions(balance, run);
  return new Set([...(runState.namedDefeated ?? []).map(id => nf[id] ?? id), ...(runState.conquered ?? [])]);
}

/** 每分钟补兵数（按 20/时长 缩放） */
export const reinforcePerMin = run => (run.named_reinforce?.per_min ?? 0) * (run.named_reinforce?.ref_duration_min ?? run.duration_min) / run.duration_min;

/**
 * 名将军补兵。teams = [{ id, soldiers, cap, inBattle }]；runState.reinforceMin[id] = 已补到第几分钟。
 * 返回 [{ id, add }]（调用方改兵数）。
 */
export function namedReinforce(runState, tS, teams, run) {
  const per = reinforcePerMin(run), out = [];
  if (!(per > 0)) return out;
  const m = Math.floor(tS / 60 + 1e-9);
  if (!runState.reinforceMin) { // 旧存档（没有这个字段）：从现在开始计，不一次补发之前的分钟
    runState.reinforceMin = Object.fromEntries(teams.filter(t => run.run_goal.named.includes(t.id)).map(t => [t.id, m]));
    return out;
  }
  for (const t of teams) {
    if (!run.run_goal.named.includes(t.id)) continue;
    const last = runState.reinforceMin[t.id] ?? 0;
    if (m <= last || t.inBattle) continue;
    runState.reinforceMin[t.id] = m;
    const add = Math.min(Math.max(0, t.cap - t.soldiers), Math.round(per * (m - last)));
    if (add > 0) out.push({ id: t.id, add });
  }
  return out;
}

/** 该补校尉军的势力（按 named 顺序取第一个）；没有返回 null。aiTeams = [{ faction }] */
export function factionToRefill(runState, aiTeams, balance, run) {
  if (!run.faction_refill?.enabled) return null;
  const nf = namedFactions(balance, run), done = conqueredFactions(runState, balance, run);
  for (const f of Object.values(nf)) {
    if (done.has(f)) continue;
    if (!aiTeams.some(t => t.faction === f)) return f;
  }
  return null;
}

/** 势力兵种 = 该势力名将军的兵种（units.named_army_units） */
export function factionUnit(faction, balance, run, namedArmyUnits) {
  const id = Object.entries(namedFactions(balance, run)).find(([, f]) => f === faction)?.[0];
  return namedArmyUnits?.[id] ?? 'inf';
}

/** 校尉军（纯数据 team）；home = 大本营像素坐标 */
export function buildRefillTeam({ id, faction, home, playerPower, balance, run, rng, unit }) {
  const R = run.faction_refill, fac = balance.ai.factions.find(f => f.id === faction);
  const g = { id: `${id}_gen`, name: `${fac?.name ?? faction}校尉`, generic: true,
    lead: randInt(rng, R.lead_str[0], R.lead_str[1]), str: randInt(rng, R.lead_str[0], R.lead_str[1]),
    int: randInt(rng, R.int_cha[0], R.int_cha[1]), cha: randInt(rng, R.int_cha[0], R.int_cha[1]) };
  const team = { id, faction, is_player: false, soldiers: 1, generals: [g], items: [], position: { ...home }, state: 'wander',
    name: `${fac?.name ?? faction}·校尉军`, home: { ...home }, unit, refill: true };
  const [lo, hi] = R.power_rand;
  const target = Math.max(R.power_floor, playerPower) * (lo + rng() * (hi - lo));
  const p = balance.power, M = 1 + p.k_lead * mainGeneral(team, balance).lead + p.k_str * g.str;
  const cap = balance.team_rules.soldier_cap_base + balance.team_rules.soldier_cap_per_lead * g.lead;
  team.soldiers = Math.min(cap, Math.max(balance.spawn.min_soldiers, roundHalfUp((target - p.k_gen * g.str) / M)));
  team.targetPower = target;
  return team;
}

/** 讨伐判定：名将军；或（counts_when_named_lost）名将军已不在场且未被玩家讨伐时，该势力的校尉军 */
export function conquestTarget(team, runState, namedAlive, balance, run) {
  if (run.run_goal.named.includes(team.id)) return { faction: namedFactions(balance, run)[team.id], namedId: team.id };
  if (team.refill && run.faction_refill?.counts_when_named_lost) {
    const id = Object.entries(namedFactions(balance, run)).find(([, f]) => f === team.faction)?.[0];
    if (id && !namedAlive(id) && !conqueredFactions(runState, balance, run).has(team.faction)) return { faction: team.faction, namedId: id };
  }
  return null;
}
