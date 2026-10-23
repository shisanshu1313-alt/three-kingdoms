/**
 * v0.5 势力相关的一局规则（纯函数，无 Phaser；配置 run_v05.json ← balance_v0.5.json polish_merged）：
 *   - 名将军补兵（4_named_reinforce）：名将军不在交战中每累计 60 s +per_min 兵（按 20/时长 缩放），不超过兵力上限；
 *     交战中计时暂停，战斗结束后不补算错过的时间（策划确认）
 *   - 势力补队（3_faction_refill）：魏蜀吴群没被讨伐、且场上没有该势力的队伍 → 下一次刷新改为在其大本营刷一支「校尉军」：
 *     武将统武 60–80、智魅 40–70，兵种 = 势力兵种（名将军的兵种），战力 = max(120, 玩家战力) × U(0.8, 1.2)
 *   - 讨伐：击败名将军（玩家有伤害份额）才算；名将军被其他 AI 打掉（玩家没有份额）后，玩家击败该势力的校尉军也算（策划确认）
 */
import { randInt } from './rng.js';
import { roundHalfUp } from './combat.js';
import { leaderLead, recalcLeader } from './leader.js';

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
 * 名将军补兵（每个名将军一个计时器，存在 runState.reinforceT[id]，随 run 存档）：
 *   不在交战中时计时 += dt，满 60 s 补 per_min 兵（≤ 上限）；交战中计时暂停（pause_in_battle），战后不补算错过的时间。
 * teams = [{ id, soldiers, cap, inBattle }]；返回 [{ id, add }]（调用方改兵数）。
 */
export function namedReinforce(runState, dt, teams, run) {
  const R = run.named_reinforce, per = reinforcePerMin(run), out = [];
  if (!(per > 0)) return out;
  runState.reinforceT ??= {}; // 旧存档（只有 reinforceMin 或都没有）：从 0 开始计
  for (const t of teams) {
    if (!run.run_goal.named.includes(t.id)) continue;
    if (t.inBattle && R.pause_in_battle !== false) continue;
    let acc = (runState.reinforceT[t.id] ?? 0) + dt;
    let add = 0;
    while (acc + 1e-9 >= 60) { acc -= 60; add += per; }
    runState.reinforceT[t.id] = +acc.toFixed(6);
    add = Math.min(Math.max(0, t.cap - t.soldiers), Math.round(add));
    if (add > 0) out.push({ id: t.id, add });
  }
  return out;
}

/** 名将军被击败但不是玩家讨伐的（玩家没有伤害份额 = 被其他 AI 打掉）→ 记下来，之后该势力的校尉军可算讨伐 */
export function onNamedLost(runState, id, run) {
  if (!run.run_goal.named.includes(id) || (runState.namedDefeated ?? []).includes(id)) return false;
  runState.namedLostToAI ??= [];
  if (!runState.namedLostToAI.includes(id)) runState.namedLostToAI.push(id);
  return true;
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
export function buildRefillTeam({ id, faction, home, playerPower, balance, run, rng, unit, powerRange = null, label = '校尉军' }) {
  const R = run.faction_refill, fac = balance.ai.factions.find(f => f.id === faction);
  const g = { id: `${id}_gen`, name: `${fac?.name ?? faction}校尉`, generic: true,
    lead: randInt(rng, R.lead_str[0], R.lead_str[1]), str: randInt(rng, R.lead_str[0], R.lead_str[1]),
    int: randInt(rng, R.int_cha[0], R.int_cha[1]), cha: randInt(rng, R.int_cha[0], R.int_cha[1]) };
  const team = { id, faction, is_player: false, soldiers: 1, generals: [g], items: [], position: { ...home }, state: 'wander',
    name: `${fac?.name ?? faction}·${label}`, fixedName: true, home: { ...home }, unit, refill: true };
  // v0.6 讨伐军（city_v06.ai_siege_player.spawn_ratio）：powerRange 给定时 = 玩家战力 × U(lo, hi)，不套校尉军的战力下限
  const [lo, hi] = powerRange ?? R.power_rand;
  const target = (powerRange ? playerPower : Math.max(R.power_floor, playerPower)) * (lo + rng() * (hi - lo));
  const p = balance.power, M = 1 + p.k_lead * leaderLead(team, balance) + p.k_str * g.str;
  recalcLeader(team, balance);
  const cap = balance.team_rules.soldier_cap_base + balance.team_rules.soldier_cap_per_lead * g.lead;
  team.soldiers = Math.min(cap, Math.max(balance.spawn.min_soldiers, roundHalfUp((target - p.k_gen * g.str) / M)));
  team.targetPower = target;
  return team;
}

/** 讨伐判定：名将军；或（counts_when_named_lost）名将军是被其他 AI 打掉的（namedLostToAI）且势力未被讨伐时，该势力的校尉军 */
export function conquestTarget(team, runState, balance, run) {
  if (run.run_goal.named.includes(team.id)) return { faction: namedFactions(balance, run)[team.id], namedId: team.id };
  if (team.refill && run.faction_refill?.counts_when_named_lost) {
    const id = Object.entries(namedFactions(balance, run)).find(([, f]) => f === team.faction)?.[0];
    if (id && (runState.namedLostToAI ?? []).includes(id) && !conqueredFactions(runState, balance, run).has(team.faction)) return { faction: team.faction, namedId: id };
  }
  return null;
}
