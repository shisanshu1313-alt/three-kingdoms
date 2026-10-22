/**
 * 战斗生效（balance v0.2：battle / rewards / collision 段）。
 * - applyBattleResult：纯函数，把 resolveCombat 的结果应用到两个 team（掷俘获骰、改兵数/武将），node 可测
 * - BattleSystem：碰撞筛选（skip_if / multi_hit）、战斗冻结 T 秒、结束时一次性结算、平局冷却、战后保护
 */
import { resolveCombat } from './combat.js';

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** ai_loser = disband：整队移除，物品消失；未被俘名将回自由池，黄巾头目消失 */
function disband(team, out, exclude = []) {
  if (!out.removeIds.includes(team.id)) out.removeIds.push(team.id);
  for (const g of team.generals) if (!g.generic && !exclude.includes(g)) out.toFreePool.push(g.id);
}

/** battle.zero_soldier_rule：AI 兵数 0 → 按 ai_loser 移除（无额外点数）；玩家兵数不低于 player_defeat.min_soldiers */
function applyZeroSoldierRule(team, out, balance) {
  if (team.is_player) team.soldiers = Math.max(team.soldiers, balance.battle.player_defeat.min_soldiers);
  else if (team.soldiers <= 0) disband(team, out);
}

/**
 * @param a,b  team（会被修改）
 * @param r    resolveCombat(a,b) 结果
 * @returns { outcome, winnerId, loserId, removeIds, captured:[{general, to}], toFreePool:[id], pendingGenerals:[{general,source,from}],
 *            recruited, points, playerDefeat, pushback_px, pair_cooldown_s, text }
 */
export function applyBattleResult(a, b, r, balance, rng = Math.random) {
  const out = { outcome: r.outcome, removeIds: [], captured: [], toFreePool: [], pendingGenerals: [], recruited: 0, points: 0, ratio: r.ratio };
  const nameOf = t => t.name || t.id;

  if (r.outcome === 'draw') {
    a.soldiers -= r.a.losses;
    b.soldiers -= r.b.losses;
    applyZeroSoldierRule(a, out, balance); applyZeroSoldierRule(b, out, balance);
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
    disband(L, out, caught); // ai_loser = disband
  }

  // 3) 俘获去向（保留当前属性）
  for (const g of caught) {
    const copy = { ...g };
    if (W.generals.length < maxGen) { W.generals.push(copy); out.captured.push({ general: copy, to: W.id }); continue; }
    if (W.is_player) { out.pendingGenerals.push({ general: copy, source: 'capture', from: nameOf(L) }); out.captured.push({ general: copy, to: 'pending' }); } // 满编 → 替换/释放弹窗
    else if (!g.generic) { out.toFreePool.push(g.id); out.captured.push({ general: copy, to: 'free_pool' }); }  // ai_full_team
    else out.captured.push({ general: copy, to: 'vanish' }); // capture_rules.ai_full_team：被俘黄巾头目直接消失
  }

  // 4) 胜方兵数 = min(兵力上限, N_w − 损兵 + 收编)（上限按战前武将计算，见 resolveCombat）
  W.soldiers = r.winnerSoldiersAfter;
  applyZeroSoldierRule(W, out, balance);
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
  /** world = 回调对象（WorldScene 实现）：beforeBattleStart()、onBattleStart(battle)、onBattleEnd(battle, outcome)。队伍是 PartyModel（纯数据） */
  constructor(world, balance, state, rng = Math.random) {
    this.world = world; this.balance = balance; this.state = state; this.rng = rng;
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
    let saved = false;
    for (const { a, b } of cand) {
      if (a.inBattle || b.inBattle) continue;
      // 存档决定 1：开战前立即存档（只存一次；战斗结果用存档里的 combat 随机数流，读档后不会重掷）
      if (!saved) { this.world.beforeBattleStart?.(); saved = true; }
      this.start(a, b, now);
    }
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

  /** 进行中的战斗 → 纯数据（存档用） */
  serialize() {
    return this.battles.map(bt => ({ a: bt.a.id, b: bt.b.id, result: bt.result, startAt: bt.startAt, endAt: bt.endAt, lossOf: bt.lossOf, startSoldiers: bt.startSoldiers }));
  }

  /** 读档：恢复进行中的战斗（byId: id → 队伍）；返回恢复的战斗列表 */
  restore(list, byId) {
    const out = [];
    for (const d of list || []) {
      const a = byId.get(d.a), b = byId.get(d.b);
      if (!a || !b) continue;
      const battle = { a, b, result: d.result, startAt: d.startAt, endAt: d.endAt, lossOf: d.lossOf, startSoldiers: d.startSoldiers };
      a.inBattle = b.inBattle = battle;
      this.battles.push(battle);
      out.push(battle);
    }
    return out;
  }

  finish(battle, now) {
    this.battles = this.battles.filter(b => b !== battle);
    const { a, b, result } = battle;
    a.inBattle = b.inBattle = null;
    a.graceUntil = b.graceUntil = now + this.balance.battle.post_battle_grace_s * 1000;
    const before = { ...battle.startSoldiers };
    const outcome = applyBattleResult(a.team, b.team, result, this.balance, this.rng);
    outcome.before = before;
    outcome.after = { [a.id]: a.team.soldiers, [b.id]: b.team.soldiers };
    if (outcome.outcome === 'draw') this.pairCooldown.set(pairKey(a.id, b.id), now + outcome.pair_cooldown_s * 1000);
    this.state.points += outcome.points;
    this.state.freePool.push(...outcome.toFreePool);
    this.state.pendingGenerals.push(...outcome.pendingGenerals);
    for (const c of outcome.captured) if (c.to === 'player') this.state.captured.push(c.general);
    this.state.battles++;
    console.log(`[battle-end] ${outcome.text}`, outcome);
    this.world.onBattleEnd(battle, outcome);
    return outcome;
  }
}
