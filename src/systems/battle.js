/**
 * 战斗生效（balance v0.2：battle / rewards / collision 段）。
 * - applyBattleResult：纯函数，把 resolveCombat 的结果应用到两个 team（掷俘获骰、改兵数/武将），node 可测
 * - BattleSystem：碰撞筛选（skip_if / multi_hit）、战斗冻结 T 秒、结束时一次性结算、平局冷却、战后保护
 */
import { resolveCombat } from './combat.js';

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * @param a,b  team（会被修改）
 * @param r    resolveCombat(a,b) 结果
 * @param asm  assumptions.battle
 * @returns { outcome, winnerId, loserId, removeIds, captured:[{general, to}], toFreePool:[id], pendingCaptives:[general],
 *            recruited, points, playerDefeat, pushback_px, pair_cooldown_s, text }
 */
export function applyBattleResult(a, b, r, balance, asm, rng = Math.random) {
  const out = { outcome: r.outcome, removeIds: [], captured: [], toFreePool: [], pendingCaptives: [], recruited: 0, points: 0, ratio: r.ratio };
  const nameOf = t => t.name || t.id;

  if (r.outcome === 'draw') {
    a.soldiers -= r.a.losses;
    b.soldiers -= r.b.losses;
    Object.assign(out, { pushback_px: r.pushback_px, pair_cooldown_s: r.pair_cooldown_s, lossA: r.a.losses, lossB: r.b.losses });
    out.text = `${nameOf(a)} 与 ${nameOf(b)} 平局（-${r.a.losses} / -${r.b.losses}）`;
    return out;
  }

  const W = r.winner === a.id ? a : b, L = W === a ? b : a;
  const maxGen = balance.team_rules.max_generals;
  out.winnerId = W.id; out.loserId = L.id;

  // 1) 败方武将逐个掷俘获骰（概率 r.capture[id]，主角为 0）
  const caught = L.generals.filter(g => (r.capture[g.id] ?? 0) > 0 && rng() < r.capture[g.id]);
  const free = L.generals.filter(g => !caught.includes(g));

  // 2) 败方处理
  if (L.is_player) {
    L.soldiers = r.playerKept;
    L.generals = free; // 被俘随从离队，主角保留
    out.playerDefeat = r.playerDefeat;
  } else {
    out.removeIds.push(L.id); // ai_loser = disband；物品消失
    for (const g of free) if (!g.generic) out.toFreePool.push(g.id); // 未被俘名将回自由池，头目消失
  }

  // 3) 俘获去向（保留当前属性）
  for (const g of caught) {
    const copy = { ...g };
    if (W.generals.length < maxGen) { W.generals.push(copy); out.captured.push({ general: copy, to: W.id }); continue; }
    if (W.is_player) { out.pendingCaptives.push(copy); out.captured.push({ general: copy, to: 'pending' }); } // [假设] 选择 UI 待 M3
    else if (!g.generic) { out.toFreePool.push(g.id); out.captured.push({ general: copy, to: 'free_pool' }); }  // ai_full_team
    else out.captured.push({ general: copy, to: 'vanish' }); // [假设] 头目不进自由池
  }

  // 4) 胜方兵数 = min(兵力上限, N_w − 损兵 + 收编)（上限按战前武将计算，见 resolveCombat）
  W.soldiers = r.winnerSoldiersAfter;
  out.recruited = r.recruited;
  out.points = r.points;
  out.winnerLosses = r.winnerLosses; out.loserLosses = r.loserDead;

  const parts = [`${nameOf(W)} 胜 ${nameOf(L)}`, `损${r.winnerLosses}/${r.loserDead}`];
  if (r.recruited) parts.push(`收编${r.recruited}`);
  if (caught.length) parts.push(`俘${caught.map(g => g.name).join('、')}`);
  if (r.points) parts.push(`+${r.points}分`);
  if (r.bully) parts.push('以强凌弱');
  if (L.is_player) parts.push(`残部${L.soldiers}突围`);
  out.text = parts.join(' ');
  return out;
}

export default class BattleSystem {
  /** world 需提供：onBattleStart(battle)、onBattleEnd(battle, outcome) */
  constructor(world, balance, asm, state, rng = Math.random) {
    this.world = world; this.balance = balance; this.asm = asm; this.state = state; this.rng = rng;
    this.battles = [];
    this.pairCooldown = new Map(); // pairKey -> until(ms)
  }

  /** collision.skip_if：战斗中 / 战后保护 / 玩家无敌 / 同阵营 / 平局冷却 */
  canFight(a, b, now) {
    if (a.inBattle || b.inBattle) return false;
    if ((a.graceUntil ?? 0) > now || (b.graceUntil ?? 0) > now) return false;
    if (a.faction === b.faction) return false;
    if (a.isInvincible(now) || b.isInvincible(now)) return false;
    const cd = this.pairCooldown.get(pairKey(a.id, b.id));
    return !(cd && cd > now);
  }

  /** overlaps: [[a,b], ...]；multi_hit：一支队伍同时撞多队时只与中心最近的一队开战 */
  update(overlaps, now) {
    const cand = overlaps.filter(([a, b]) => this.canFight(a, b, now))
      .map(([a, b]) => ({ a, b, d: Math.hypot(a.x - b.x, a.y - b.y) }))
      .sort((p, q) => p.d - q.d);
    for (const { a, b } of cand) if (!a.inBattle && !b.inBattle) this.start(a, b, now);
    for (const bt of [...this.battles]) if (now >= bt.endAt) this.finish(bt, now);
  }

  start(a, b, now) {
    const result = resolveCombat(a.team, b.team, this.balance, this.rng);
    const battle = { a, b, result, startAt: now, endAt: now + result.duration_s * 1000 };
    // 用于“损兵数字线性播放”
    battle.lossOf = result.outcome === 'draw'
      ? { [a.id]: result.a.losses, [b.id]: result.b.losses }
      : { [result.winner]: result.winnerLosses, [result.loser]: result.loserDead };
    battle.startSoldiers = { [a.id]: a.team.soldiers, [b.id]: b.team.soldiers };
    a.inBattle = b.inBattle = battle;
    a.clearPath(); b.clearPath();
    this.battles.push(battle);
    console.log(`[battle-start] ${a.name} vs ${b.name} R=${result.ratio.toFixed(3)} T=${result.duration_s.toFixed(2)}s`);
    this.world.onBattleStart(battle);
  }

  finish(battle, now) {
    this.battles = this.battles.filter(b => b !== battle);
    const { a, b, result } = battle;
    a.inBattle = b.inBattle = null;
    a.graceUntil = b.graceUntil = now + this.balance.battle.post_battle_grace_s * 1000;
    const before = { ...battle.startSoldiers };
    const outcome = applyBattleResult(a.team, b.team, result, this.balance, this.asm, this.rng);
    outcome.before = before;
    outcome.after = { [a.id]: a.team.soldiers, [b.id]: b.team.soldiers };
    if (outcome.outcome === 'draw') this.pairCooldown.set(pairKey(a.id, b.id), now + outcome.pair_cooldown_s * 1000);
    this.state.points += outcome.points;
    this.state.freePool.push(...outcome.toFreePool);
    this.state.pendingCaptives.push(...outcome.pendingCaptives);
    for (const c of outcome.captured) if (c.to === 'player') this.state.captured.push(c.general);
    this.state.battles++;
    console.log(`[battle-end] ${outcome.text}`, outcome);
    this.world.onBattleEnd(battle, outcome);
    return outcome;
  }
}
