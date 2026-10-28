/**
 * 战斗/队伍数值公式（纯函数，无 Phaser；单测见 tests/combat.test.js 与 tests/worked_examples.test.js）。
 * 全部按 balance v0.3 的公式与 battle.numeric_rules 实现，系数从 balance 读取：
 *   中间值全程浮点；士兵数与点数在最后一步取整：
 *   roundHalfUp(x) = floor(x + 0.5 + 1e-9)（损兵/阵亡/平局损兵/点数/刷新兵数），floorEps(x) = floor(x + 1e-9)（收编/玩家保留）
 */
const EPS = 1e-9;
export const roundHalfUp = x => Math.floor(x + 0.5 + EPS);
export const floorEps = x => Math.floor(x + EPS);

const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const max = (arr, f) => arr.reduce((m, x) => Math.max(m, f(x)), 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 队伍物品某项效果之和，如 itemEffect(team, balance, 'power_pct') */
export function itemEffect(team, balance, key) {
  return sum(team.items || [], id => balance.items.find(i => i.id === id)?.effect?.[key] ?? 0);
}

import { getLeader, leaderLead, affinityBonus } from './leader.js';
import { mulberry32 } from './rng.js'; // 默认随机数也是种子流（游戏里都显式传入；不用 Math.random，保证可复现）
export { affinityBonus };

/** 兼容旧名：mainGeneral = v0.6 统帅（systems/leader.js getLeader；无 v0.6 配置时 = 旧规则统率最高） */
export const mainGeneral = (team, balance) => getLeader(team, balance);

/** 面板战力：P = N × (1 + k_lead×leaderLead + k_str×Σ武力 + 物品战力% + 擅长兵种 + 虎符) + k_gen×Σ武力（v0.6：玩家 leaderLead = L） */
export function computePower(team, balance) {
  const { k_lead, k_str, k_gen } = balance.power;
  const sumStr = sum(team.generals, g => g.str);
  return team.soldiers * (1 + k_lead * leaderLead(team, balance) + k_str * sumStr + itemEffect(team, balance, 'power_pct') + affinityBonus(team, balance) + (team.epPower ?? 0)) + k_gen * sumStr;
}

/** 兵力上限 = soldier_cap_base + soldier_cap_per_lead × Σ统率(全队) + Σ物品 soldier_cap + v0.6 万民来投（team.capBonus） */
export function soldierCap(team, balance) {
  const r = balance.team_rules;
  return r.soldier_cap_base + r.soldier_cap_per_lead * sum(team.generals, g => g.lead) + itemEffect(team, balance, 'soldier_cap') + (team.capBonus ?? 0);
}

/**
 * 移动速度（px/s，不含地形与状态倍率）：
 * speed_base × max(speed_min_mult, 1 − speed_penalty_per_soldier × N) × (1 + Σ物品speed_pct)
 * 地形倍率（terrain_speed）与战败脱离倍率（escape_speed_mult）由调用方再乘。
 */
export function teamSpeed(team, balance) {
  const r = balance.team_rules;
  return r.speed_base * Math.max(r.speed_min_mult, 1 - r.speed_penalty_per_soldier * team.soldiers) * (1 + itemEffect(team, balance, 'speed_pct'));
}

/** 损兵减免 = clamp(min(int_loss_reduction_cap, k_int × 最高智力) + Σ物品loss_reduction, 0, loss_reduction_total_cap) */
export function lossReduction(team, balance) {
  const p = balance.power;
  const fromInt = Math.min(p.int_loss_reduction_cap, p.k_int_loss_reduction * max(team.generals, g => g.int));
  return clamp(fromInt + itemEffect(team, balance, 'loss_reduction'), 0, p.loss_reduction_total_cap);
}

/** 俘获率（败方每名武将单独计算）：clamp(base + k_cha×(胜方最高魅力 − 该将魅力) + k_ratio×(R−1), min, max) */
export function captureChance(winner, general, R, balance) {
  const rw = balance.rewards;
  return clamp(rw.capture_base + rw.capture_per_cha_diff * (max(winner.generals, g => g.cha) - general.cha) + rw.capture_per_ratio * (R - 1),
    rw.capture_min, rw.capture_max);
}

/** 可否被俘：主角永不被俘（hero_never_captured）；黄巾头目按 generic_capturable */
export function isCapturable(general, balance) {
  const cr = balance.rewards.capture_rules || {};
  if ((cr.hero_never_captured ?? balance.battle.player_defeat.hero_never_captured) && general.id === balance.hero?.id) return false;
  if (general.generic && cr.generic_capturable === false) return false;
  return true;
}

/**
 * 碰撞战斗结算（纯函数，不修改队伍；结果由 systems/battle.js 的 applyBattleResult 应用）。
 * @param rng   () => [0,1)，每方独立掷 U(random_min, random_max)（先 a 后 b）
 * @param opts.rolls  [rollA, rollB] 直接指定随机系数（worked_examples / 测试用）
 */

/** 胜利点数（未乘份额）：roundHalfUp((points_base + points_per_enemy_power × 敌方面板战力) × (R≥bully_ratio ? bully_mult : 1))；面板战力不乘随机，R 乘随机后 */
export function victoryPoints(enemyPanelPower, R, balance) {
  const rw = balance.rewards;
  const bully = R >= rw.bully_ratio;
  return roundHalfUp((rw.points_base + rw.points_per_enemy_power * enemyPanelPower) * (bully ? rw.bully_mult : 1));
}

/**
 * R3-E1：平局点数 = roundHalfUp(draw_mult × points_win)；points_win 同胜利公式。
 * 仅玩家参与时由调用方决定是否计分；AI 间 / 战败仍 0。draw_mult 默认 0.5（v06.tuning.draw_points）。
 */
export function drawPoints(enemyPanelPower, R, balance) {
  const mult = balance.v06?.tuning?.draw_points?.draw_mult ?? 0.5;
  return roundHalfUp(mult * victoryPoints(enemyPanelPower, R, balance));
}

export function resolveCombat(a, b, balance, rng = mulberry32(0x5eed), opts = {}) {
  const bt = balance.battle, rw = balance.rewards;
  const roll = () => bt.random_min + rng() * (bt.random_max - bt.random_min);
  const [rollA, rollB] = opts.rolls ?? [roll(), roll()];
  const basePa = computePower(a, balance), basePb = computePower(b, balance);
  const Pa = basePa * rollA, Pb = basePb * rollB;
  const R = Math.max(Pa, Pb) / Math.max(1e-9, Math.min(Pa, Pb));
  const duration = clamp(bt.duration_base_s + bt.duration_k_s / R, bt.duration_min_s, bt.duration_max_s);
  const rawDead = (team, frac) => team.soldiers * frac * (1 - lossReduction(team, balance));
  const dead = (team, frac) => clamp(roundHalfUp(rawDead(team, frac)), 0, team.soldiers);

  const base = {
    a: { id: a.id, power: basePa, rolled: Pa, roll: rollA },
    b: { id: b.id, power: basePb, rolled: Pb, roll: rollB },
    ratio: R, duration_s: duration
  };

  if (R < bt.draw_ratio) {
    const la = dead(a, bt.draw_loss), lb = dead(b, bt.draw_loss);
    // R3-E1：恰好一方是玩家 → 平局给 0.5× 胜利点数（敌方面板=战前不乘随机；AI 间仍 0）
    const playerVsAi = (!!a.is_player) !== (!!b.is_player);
    const enemyPanel = a.is_player ? basePb : basePa;
    const points = playerVsAi ? drawPoints(enemyPanel, R, balance) : 0;
    return {
      ...base, outcome: 'draw', points,
      a: { ...base.a, losses: la, survivors: a.soldiers - la },
      b: { ...base.b, losses: lb, survivors: b.soldiers - lb },
      pushback_px: bt.draw_pushback_px, pair_cooldown_s: bt.draw_pair_cooldown_s
    };
  }

  const aWins = Pa > Pb;
  const W = aWins ? a : b, L = aWins ? b : a;
  const wFrac = bt.winner_loss_base * Math.pow(1 / R, bt.winner_loss_exp);
  const lFrac = Math.min(bt.loser_loss_max, bt.loser_loss_base + bt.loser_loss_per_ratio * (R - 1));
  const winnerLossesRaw = rawDead(W, wFrac), loserDeadRaw = rawDead(L, lFrac);
  const winnerLosses = dead(W, wFrac);
  const loserDead = dead(L, lFrac);
  const loserSurvivors = L.soldiers - loserDead;

  // 玩家战败：先保留 max(min_soldiers, floor(溃兵 × keep_survivor_ratio))，剩余溃兵供 AI 收编
  let playerKept = null, recruitBase = loserSurvivors;
  if (L.is_player) {
    const pd = bt.player_defeat;
    playerKept = Math.max(pd.min_soldiers, floorEps(loserSurvivors * pd.keep_survivor_ratio));
    recruitBase = Math.max(0, loserSurvivors - playerKept);
  }
  const canRecruit = W.is_player || rw.ai_also_recruits;
  const recruitRate = canRecruit
    ? Math.min(rw.recruit_max, rw.recruit_base + rw.recruit_per_cha * max(W.generals, g => g.cha) + itemEffect(W, balance, 'recruit_pct'))
    : 0;
  const recruited = floorEps(recruitBase * recruitRate);
  // soldier_cap_timing：上限按战斗开始时的武将和物品计算，本场俘获入队的武将下一场才生效
  const winnerSoldierCap = soldierCap(W, balance);
  const winnerSoldiersAfter = Math.min(winnerSoldierCap, W.soldiers - winnerLosses + recruited);

  const bully = R >= rw.bully_ratio;
  const loserPanel = aWins ? basePb : basePa; // 战前面板战力，不乘随机
  const points = W.is_player ? victoryPoints(loserPanel, R, balance) : 0;

  const capture = {};
  for (const g of L.generals) capture[g.id] = isCapturable(g, balance) ? captureChance(W, g, R, balance) : 0;

  const result = {
    ...base, outcome: aWins ? 'a_wins' : 'b_wins', winner: W.id, loser: L.id, bully,
    winnerLosses, loserDead, loserLosses: loserDead, loserSurvivors, winnerLossesRaw, loserDeadRaw,
    reductionWinner: lossReduction(W, balance), reductionLoser: lossReduction(L, balance), winnerSoldierCap,
    playerKept, recruitBase, recruitRate, recruited, winnerSoldiersAfter, points, capture
  };
  if (L.is_player) {
    const pd = bt.player_defeat;
    result.playerDefeat = { keptSoldiers: playerKept, invincible_s: pd.invincible_s, escape_speed_mult: pd.escape_speed_mult };
  }
  return result;
}
