/**
 * v0.5 AI 战术（balance_v0.5.json → battle_move.ai_tactics；纯函数，无 Phaser）。
 * 只管“已经开打（有交战对象）”的 AI；没开打时仍由 aiBrain.decide + ai.js 寻路决定去哪。
 *   - 骑兵：对枪兵 40% 速度慢慢贴上（不触发反冲锋）；对弓兵直追；其他：冲击-回撤（runup_px，接触 hitrun_hold_s 后拉开再冲）
 *   - 弓兵：对骑兵站桩；其他：保持 kite_gap_px 间隙边退边射，弹药用完站桩
 *   - 枪兵：对骑兵原地列阵；其他：站桩
 *   - 撤退：r = E_self / E_opp ≤ r_th 且 raw ≥ loss_th → 朝远离方向全速（按性格）
 *   - 追击：对手在撤（背向移动，接触中也算）或溃逃时追 pursue_max_s；自己快 10% 以上追 pursue_fast_s；然后放弃（原地停）
 * mem（每个 AI 一份，可存档）：{ mode, hold, pursueT, target }
 */
import { soldiersOf, radiusOf, vmaxOf, effPower, angDiff, unitDef } from './melee.js';

export function newCombatMem() { return { mode: 'approach', hold: 0, pursueT: 0, target: null, gaveUp: false }; }

const toward = (X, Y) => Math.atan2(Y.y - X.y, Y.x - X.x);

/** 对手是否在撤：朝向背离我（> escaping_heading_deg）且在移动 */
export function isRetreating(Y, X, cfg) {
  return Math.abs(angDiff(toward(Y, X), Y.h)) > cfg.assumed.escaping_heading_deg * Math.PI / 180 && Y.v > cfg.assumed.escaping_min_speed_frac * vmaxOf(Y, cfg);
}

/** @returns { h, v, target, mode } */
export function combatIntent(X, state, mem, cfg, personalityKey = 'normal', dt = cfg.tick_s) {
  const B = state.bodies, MP = cfg.move, AS = cfg.assumed;
  const foes = (X.foes || []).map(id => B[id]).filter(Boolean);
  if (!foes.length) return null;
  const dist = Y => Math.hypot(Y.x - X.x, Y.y - X.y);
  let T = B[mem.target] && foes.includes(B[mem.target]) ? B[mem.target] : foes.sort((p, q) => dist(p) - dist(q))[0];
  mem.target = T.id;
  const vm = vmaxOf(X, cfg), d = dist(T), h = toward(X, T);
  const gap = d - radiusOf(soldiersOf(X), cfg) - radiusOf(soldiersOf(T), cfg);
  const contact = gap <= 0;
  const out = (hh, v, mode = mem.mode) => ({ h: hh, v, target: T.id, mode });

  // 撤退（按性格）
  const [rTh, lossTh] = AS.retreat_by_personality[personalityKey] ?? AS.retreat_by_personality.normal;
  const eSelf = effPower(X, T, cfg, state.chapter);
  const eOpp = foes.reduce((s, Y) => s + effPower(Y, X, cfg, state.chapter), 0);
  if (mem.mode === 'retreat' || (eSelf / Math.max(1e-9, eOpp) <= rTh && X.raw >= lossTh)) {
    mem.mode = 'retreat';
    return out(h + Math.PI, vm, 'retreat');
  }

  // 追击计时（同 sim_v05_move.pol_pursue）：对手在撤（背向移动）或溃逃时累计，接触中也算、不清零；
  // 超过 pursue_max_s（自己快 10% 以上 pursue_fast_s）就放弃（原地停）。对手回头接战才清零。
  if (T.routed || isRetreating(T, X, cfg)) {
    mem.pursueT += dt;
    const lim = vm >= 1.1 * vmaxOf(T, cfg) ? MP.pursue_fast_s : MP.pursue_max_s;
    if (mem.pursueT > lim) { mem.gaveUp = true; return out(h, 0, 'giveup'); }
    return out(h, vm, 'pursue');
  }
  if (contact) { mem.pursueT = 0; mem.gaveUp = false; }
  if (mem.gaveUp) return out(h, 0, 'giveup');

  const mine = X.unit, theirs = T.unit;
  const stand = () => out(h, contact ? 0 : vm, 'stand');
  if (mine === 'cav') {
    if (unitDef(cfg, theirs).anti_charge) return out(h, contact ? 0 : vm * AS.walk_vs_brace_mult, 'walk');
    if (theirs === 'arc') return stand();
    // 冲击-回撤
    if (mem.mode === 'approach' || mem.mode === 'stand' || mem.mode === 'pursue') mem.mode = (gap > MP.runup_px || X.cd <= 0) ? 'charge' : 'pull';
    if (mem.mode === 'charge') {
      if (contact) { mem.hold += dt; if (mem.hold >= AS.hitrun_hold_s) { mem.mode = 'pull'; mem.hold = 0; } }
      return out(h, vm, 'charge');
    }
    if (mem.mode === 'pull') {
      if (gap >= MP.runup_px && X.cd <= 0) { mem.mode = 'charge'; return out(h, vm, 'charge'); }
      if (gap >= MP.runup_px) return out(h, 0, 'pull'); // 拉开到助跑距离就停下、面向对手等冷却（不然会跑出 150 px 自己脱离）
      return out(h + Math.PI, vm, 'pull');
    }
    return stand();
  }
  if (mine === 'arc') {
    if (theirs === 'cav' || X.ammo <= 0) return stand();
    const [lo, hi] = AS.kite_gap_px;
    if (gap < lo) return out(h + Math.PI, vm, 'kite');
    if (gap > hi) return out(h, vm * 0.6, 'kite');
    return out(h, 0, 'kite');
  }
  if (mine === 'spr' && theirs === 'cav') return out(h, 0, 'hold');
  return stand();
}
