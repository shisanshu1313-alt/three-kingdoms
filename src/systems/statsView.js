/**
 * HUD 属性面板的数据（纯 JS，无 Phaser / DOM；单测见 tests/statsView.test.js）。
 * 只做“展示用的换算”：所有数值都调用现有公式（combat.js / melee.js）并读配置，不另写系数。
 *
 *   buildStatsView(team, balance, cfg?)  → 面板数据（主角四维、统帅、每名武将、派生值）
 *   flattenStats(view)                  → { 键: 值 }，用于比较变化
 *   changedKeys(prev, next)              → 变化了的键（Set），HUD 据此高亮
 *   fmtPct(x)                            → 0.125 → "12.5%"
 *
 * 统帅（v0.6 leader_v06）：玩家队统帅永远是主角（★ 统帅），其余武将是副将；结算统一走 systems/leader.js：
 *   战力统率项 = k_lead × L（L = 主角统率 + sub_lead_k × Σ副将统率），统率速度用 min(L, speed_L_cap)，擅长兵种看副将（A4）。
 *   view.L = { total, hero, deputies, k, speedCap, speedL } 供面板显示公式。
 * cfg = 战斗配置（melee.makeCombatConfig 的结果，即 WorldScene.field.cfg）；不传时兵种项（兵种减伤、兵种速度、统率速度）为 null。
 */
import { computePower, soldierCap, teamSpeed, lossReduction, itemEffect, affinityBonus } from './combat.js';
import { getLeader, leaderLead, speedLead, affinityGeneral, isPlayerTeam } from './leader.js';
import { teamStats, unitDef } from './melee.js';

export const ATTRS = ['lead', 'str', 'int', 'cha'];
const maxOf = (arr, k) => arr.reduce((m, g) => Math.max(m, g[k] ?? 0), 0);
const sumOf = (arr, k) => arr.reduce((s, g) => s + (g[k] ?? 0), 0);

/** 收编率（与 fieldBattle.defeatResult 相同）：min(recruit_max, recruit_base + recruit_per_cha × 最高魅力 + Σ物品 recruit_pct) */
export function recruitRate(team, balance) {
  const rw = balance.rewards;
  return Math.min(rw.recruit_max, rw.recruit_base + rw.recruit_per_cha * maxOf(team.generals, 'cha') + itemEffect(team, balance, 'recruit_pct'));
}

export function buildStatsView(team, balance, cfg = null) {
  const gs = team.generals || [];
  const heroId = balance.hero?.id;
  const mg = getLeader(team, balance); // 统帅（玩家 = 主角；敌队 A3）
  const af = balance.v05?.units?.affinity?.table ?? {};
  const generals = gs.map(g => ({
    id: g.id, name: g.name, tier: g.tier ?? null, generic: !!g.generic,
    lead: g.lead, str: g.str, int: g.int, cha: g.cha,
    isHero: g.id === heroId, isMain: g === mg, affinity: af[g.id] ?? null,
    role: g === mg ? 'leader' : 'deputy' // ★ 统帅 / 副将
  }));
  const hero = generals.find(g => g.isHero) ?? null;
  const leader = generals.find(g => g.role === 'leader') ?? null;
  const p = balance.power, tr = balance.team_rules, rw = balance.rewards;

  const sumLead = sumOf(gs, 'lead'), sumStr = sumOf(gs, 'str'), maxInt = maxOf(gs, 'int'), maxCha = maxOf(gs, 'cha');
  const mainLead = leaderLead(team, balance);
  const L06 = balance.v06?.leader;
  const deputies = gs.filter(g => g !== mg);
  const Lview = { total: mainLead, leader: mg?.lead ?? 0, deputies: sumOf(deputies, 'lead'), k: isPlayerTeam(team, balance) && L06 ? L06.sub_lead_k : 0,
    speedCap: isPlayerTeam(team, balance) && L06 ? L06.speed_L_cap : null, speedL: speedLead(team, balance) };
  const epPower = team.epPower ?? 0;
  const powerPct = itemEffect(team, balance, 'power_pct');
  const aff = affinityBonus(team, balance);
  // 战力倍率 = 1 + k_lead×L + k_str×Σ武力 + 物品战力% + 擅长兵种 + 虎符（computePower 的括号内）
  const powerMult = 1 + p.k_lead * mainLead + p.k_str * sumStr + powerPct + aff + epPower;

  // 损兵减免：智力部分 = min(上限, k_int × 最高智力)；合计 = lossReduction（含兵书）；战斗中再加兵种 red（melee.teamStats）
  const intRed = Math.min(p.int_loss_reduction_cap, p.k_int_loss_reduction * maxInt);
  const itemRed = itemEffect(team, balance, 'loss_reduction');
  const teamRed = lossReduction(team, balance);
  const st = cfg ? teamStats(team, balance, cfg) : null;
  const unitRed = cfg ? (unitDef(cfg, team.unit).red ?? 0) : null;

  const recruitCha = rw.recruit_base + rw.recruit_per_cha * maxCha;
  const recruitItems = itemEffect(team, balance, 'recruit_pct');

  const baseSpeed = teamSpeed(team, balance); // v0.4 速度（兵数、物品），不含地形
  const unitSpeed = cfg ? unitDef(cfg, team.unit).speed : null;

  return {
    hero, leader: leader ? { id: leader.id, name: leader.name, lead: leader.lead } : null,
    main: mg ? { id: mg.id, name: mg.name, lead: mg.lead } : null, L: Lview, maxGenerals: tr.max_generals, generals,
    unit: team.unit ?? null, soldiers: team.soldiers,
    cap: { total: soldierCap(team, balance), base: tr.soldier_cap_base, perLead: tr.soldier_cap_per_lead, sumLead, fromLead: tr.soldier_cap_per_lead * sumLead, items: itemEffect(team, balance, 'soldier_cap') },
    power: { total: computePower(team, balance), mult: powerMult, lead: p.k_lead * mainLead, str: p.k_str * sumStr, items: powerPct, affinity: aff, epPower, genTerm: p.k_gen * sumStr, sumStr },
    lossRed: { int: intRed, maxInt, k: p.k_int_loss_reduction, intCap: p.int_loss_reduction_cap, items: itemRed, team: teamRed, unit: unitRed, total: st ? st.red : teamRed, totalCap: p.loss_reduction_total_cap },
    recruit: { total: recruitRate(team, balance), base: rw.recruit_base, perCha: rw.recruit_per_cha, maxCha, fromCha: recruitCha, items: recruitItems, max: rw.recruit_max },
    speed: { base: baseSpeed, unit: unitSpeed, leadMult: st ? st.leadMult : null, total: st ? baseSpeed * unitSpeed * st.leadMult : null },
    affinity: { main: mg ? (af[mg.id] ?? null) : null, active: aff > 0, bonus: aff, by: affinityGeneral(team, balance)?.name ?? null }
  };
}

/**
 * 展示值摊平成 { 键: 值 }（浮点按 1e-6 取整，避免误报变化）。
 * 只放“属性 / 武将 / 兵种 / 物品”决定的值：战力总值、行军速度随兵数天天变（征兵、交战），不参与高亮，面板照常显示最新值。
 */
export function flattenStats(v) {
  const r = x => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x);
  const out = {};
  for (const g of v.generals) for (const a of ATTRS) out[`gen.${g.id}.${a}`] = g[a];
  if (v.hero) for (const a of ATTRS) out[`hero.${a}`] = v.hero[a];
  out['leader.id'] = v.leader?.id ?? null;
  out['main.id'] = v.main?.id ?? null; out.L = r(v.L.total);
  out.unit = v.unit;
  out.cap = v.cap.total;
  out.powerMult = r(v.power.mult);
  out.intRed = r(v.lossRed.int); out.lossRed = r(v.lossRed.total);
  out.recruit = r(v.recruit.total);
  out.leadMult = r(v.speed.leadMult);
  out.affinity = v.affinity.active;
  return out;
}

/** 两份 flattenStats 的差异（prev 为空 = 首次，不算变化） */
export function changedKeys(prev, next) {
  const s = new Set();
  if (!prev) return s;
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) if (prev[k] !== next[k]) s.add(k);
  return s;
}

export function fmtPct(x, digits = 1) {
  if (x === null || x === undefined) return '-';
  const v = Math.round(x * 100 * 10 ** digits) / 10 ** digits;
  return `${Number.isInteger(v) ? v : v.toFixed(digits)}%`;
}
