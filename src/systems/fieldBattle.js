/**
 * 大地图上的 v0.5 实时战斗（纯 JS，无 Phaser）：把 PartyModel 接到 melee.step 上。
 *   - 每个固定 tick：收集玩家 / AI 的期望朝向与速度（交战中的 AI 用 combatAI 战术）→ step → 位置写回队伍
 *   - 处理 step 发出的事件：溃败（奖励按伤害份额、收编/俘获归最大贡献者）、逃脱（保护 / 忽略）、平局、战斗结束写回兵数
 * hooks（由 WorldScene 实现，只做表现和移除队伍）：
 *   onEngage(a, b)、onEffect(type, party, extra)、onBattleEnd({a, b}, outcome)、onEscape(escaper, from)、onCombatEnd(party)、onPlayerWiped(party)
 */
import { createCombatState, addBody, removeBody, makeBody, syncBodyFromTeam, step, inCombat, soldiersOf, effPower, makeCombatConfig } from './melee.js';
import { combatIntent, newCombatMem } from './combatAI.js';
import { applyBattleResult } from './battle.js';
import { computePower, soldierCap, captureChance, isCapturable, itemEffect, roundHalfUp, floorEps } from './combat.js';

/**
 * 溃败奖励（纯函数）：返回 applyBattleResult 需要的结果对象 + 玩家点数
 * @param W,L     胜方（最大贡献者）/ 败方 team（兵数已写回）
 * @param info    { R: 溃败时有效战力比 W/L, power0: 败方开战时面板战力, playerShare: 玩家的伤害份额 }
 */
export function defeatResult(W, L, info, balance) {
  const rw = balance.rewards;
  const R = Math.max(1, info.R);
  const loserSurvivors = L.soldiers;
  const canRecruit = W.is_player || rw.ai_also_recruits;
  const maxCha = Math.max(0, ...W.generals.map(g => g.cha));
  const recruitRate = canRecruit ? Math.min(rw.recruit_max, rw.recruit_base + rw.recruit_per_cha * maxCha + itemEffect(W, balance, 'recruit_pct')) : 0;
  const recruited = floorEps(loserSurvivors * recruitRate);
  const bully = R >= rw.bully_ratio;
  // 点数：v0.4 公式算整场点数，玩家按自己对败方造成的伤害份额拿（AI 不计点数）
  const fullPoints = (rw.points_base + rw.points_per_enemy_power * info.power0) * (bully ? rw.bully_mult : 1);
  const points = roundHalfUp(fullPoints * (info.playerShare ?? 0));
  const capture = {};
  for (const g of L.generals) capture[g.id] = isCapturable(g, balance) ? captureChance(W, g, R, balance) : 0;
  return {
    outcome: 'rout', winner: W.id, loser: L.id, ratio: R, bully,
    winnerLosses: info.winnerLosses ?? 0, loserDead: info.loserDead ?? 0, recruited,
    winnerSoldiersAfter: Math.min(soldierCap(W, balance), W.soldiers + recruited),
    points: 0, playerPoints: points, capture, playerKept: null
  };
}

export default class FieldBattle {
  /** combatJson = data/combat_v05.json；state = gameState（点数/自由池/待安排武将）；rng = 存档里的 combat 随机数流（俘获骰） */
  constructor({ combatJson, balance, gameState, rng, seed = 1, hooks = {}, restore = null }) {
    this.balance = balance; this.cfg = makeCombatConfig(combatJson, balance);
    this.gameState = gameState; this.rng = rng; this.hooks = hooks;
    this.state = restore?.state ?? createCombatState({ seed, chapter: this.cfg.chapter ?? 0 });
    this.mem = restore?.mem ?? {};
    this.parties = new Map();
  }

  get t() { return this.state.t; }
  body(id) { return this.state.bodies[id]; }

  /** 队伍进入大地图（读档时战斗体已在 state 里就沿用） */
  add(party) {
    this.parties.set(party.id, party);
    if (!this.state.bodies[party.id]) addBody(this.state, makeBody(party.team, this.balance, this.cfg));
    party.combat = this;
    this._syncParty(party);
  }
  pruneOrphans(ids) { for (const id of Object.keys(this.state.bodies)) if (!ids.has(id)) this.remove(id); }
  remove(id) { this.parties.delete(id); removeBody(this.state, id); delete this.mem[id]; }
  /** 队伍数值变化（抽卡/收编/换兵种）后调用 */
  refresh(party) { const b = this.body(party.id); if (b) syncBodyFromTeam(b, party.team, this.balance, this.cfg); }
  /** 瞬移（调试 / 测试 / 平局推开） */
  teleport(party, x, y) { const b = this.body(party.id); if (b) { b.x = x; b.y = y; b.v = 0; } party.setPosition(x, y); }

  _syncParty(p) {
    const b = this.body(p.id); if (!b) return;
    p.setPosition(b.x, b.y);
    p.heading = b.h;
    p.inBattle = inCombat(b) ? { since: b.combatStart ?? this.t } : null;
  }

  /**
   * 一个固定 tick。
   * @param env    { fits(body,x,y), speedMult(x,y), hostile(a,b) }（WorldModel 提供）
   * @param nowMs  游戏时钟（AI 忽略名单 / 保护时间换算）
   */
  tick(dt, env, nowMs) {
    const inputs = {};
    for (const [id, p] of this.parties) {
      const b = this.body(id); if (!b) continue;
      if (!p.isPlayer && inCombat(b)) {
        const mem = this.mem[id] ??= newCombatMem();
        mem.noRetreat = !!p.team?.noRetreat;
        const it = combatIntent(b, this.state, mem, this.cfg, p.ai?.personality?.key ?? 'normal', dt);
        if (it) {
          // 追击 / 放弃追击 给表现层一个提示
          if (it.mode !== p.combatMode && (it.mode === 'pursue' || it.mode === 'giveup' || it.mode === 'retreat')) this.hooks.onEffect?.(it.mode, p, { target: it.target });
          inputs[id] = it; p.clearPath(); p.combatMode = it.mode; continue;
        }
      }
      if (!inCombat(b) && this.mem[id]) delete this.mem[id];
      p.combatMode = null;
      inputs[id] = p.intent ? { ...p.intent } : { h: b.h, v: 0 };
      if (p.isPlayer && b.unit === 'arc') inputs[id].target = this._nearestHostile(b, env);
    }
    const fighting = new Set(Object.values(this.state.bodies).filter(inCombat).map(b => b.id));
    this.state = step(this.state, inputs, dt, this.cfg, env);
    // 第三方加入：开战的一方原本已经在打别人
    for (const e of this.state.events) if (e.type === 'engage') e.join = fighting.has(e.a) ? e.b : fighting.has(e.b) ? e.a : null;
    // fresh = 这一场是新开的一方（开战前不在交战）；已在交战的一方（被第三方加入的）不在里面 —— 守军重算只认 fresh（power_recalc.third_party）
    for (const e of this.state.events) if (e.type === 'engage') e.fresh = [e.a, e.b].filter(id => !fighting.has(id));
    for (const p of this.parties.values()) { this._syncParty(p); p.intent = null; }
    for (const e of this.state.events) this._handle(e, nowMs);
    return this.state.events;
  }

  _nearestHostile(b, env) {
    let best = null, bd = Infinity;
    for (const o of Object.values(this.state.bodies)) {
      if (o.id === b.id || !(env?.hostile ?? ((x, y) => x.faction !== y.faction))(b, o)) continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y); if (d < bd) { bd = d; best = o.id; }
    }
    return best;
  }

  _handle(e, nowMs) {
    const P = id => this.parties.get(id), H = this.hooks;
    const cd = this.cfg.cooldown, nowS = nowMs / 1000;
    if (e.type === 'separate') console.log(`[separate] ${P(e.a)?.name ?? e.a} / ${P(e.b)?.name ?? e.b}: ${e.kind}`);
    switch (e.type) {
      case 'engage': {
        const a = P(e.a), b = P(e.b);
        console.log(`[battle-start] ${a?.name} vs ${b?.name} (${e.why})${e.join ? ` 加入: ${P(e.join)?.name}` : ''}`);
        if (e.join) H.onEffect?.('join', P(e.join), e);
        H.onEngage?.(a, b, e); break;
      }
      case 'impact': case 'braced': case 'rout': case 'rout-recover': case 'protect-cancel':
        H.onEffect?.(e.type, P(e.id), e); break;
      case 'combat-end': {
        const p = P(e.id); if (!p) break;
        const b = this.body(p.id); p.team.soldiers = b ? roundHalfUp(soldiersOf(b)) : e.soldiers; p.refresh(); this.refresh(p); // 同一 tick 的收编已加到战斗体上
        H.onCombatEnd?.(p, e); break;
      }
      case 'escape': {
        const esc = P(e.id), from = P(e.from); if (!esc) break;
        const until = nowMs + (this.body(e.id).protectUntil - this.t) * 1000;
        esc.invincibleUntil = until; // AI 不把保护中的队伍当目标（aiBrain valid_target）
        if (from?.ai) { from.ai.ignore = { ...from.ai.ignore, [esc.id]: nowS + cd.ignore_s }; from.ai.state = 'return'; from.ai.targetId = null; from.clearPath(); }
        if (esc.isPlayer) {
          // 其他正在追玩家的 AI 放弃 others_give_up_player_s 秒
          for (const p of this.parties.values()) if (p.ai?.state === 'chase' && p.ai.targetId === esc.id && p !== from) {
            p.ai.ignore = { ...p.ai.ignore, [esc.id]: nowS + this.cfg.confirmed.others_give_up_player_s }; p.ai.state = 'wander'; p.ai.targetId = null; p.clearPath();
          }
        }
        console.log(`[escape] ${esc.name} 脱离 ${from?.name}`);
        H.onEscape?.(esc, from, { ...e, net: this.playerNet(esc, from) }); break;
      }
      case 'separate': {
        if (e.kind === 'draw' || e.kind === 'apart' || e.kind === 'separated') { // separated = v0.6 无接触结束（同 apart）
          const a = P(e.a), b = P(e.b);
          for (const [x, y] of [[a, b], [b, a]]) if (x?.ai && y) { x.ai.ignore = { ...x.ai.ignore, [y.id]: nowS + this.cfg.confirmed.draw_ignore_s }; x.ai.state = 'return'; x.ai.targetId = null; x.clearPath(); }
          if (e.kind === 'draw') H.onDraw?.(a, b, { ...e, net: this.playerNet(a, b) });
          if (e.kind === 'separated') H.onSeparated?.(a, b, { ...e, net: this.playerNet(a, b) });
        }
        break;
      }
      case 'defeat': return this._defeat(e, nowMs);
      case 'player-wiped': {
        const p = P(e.id); if (!p) break;
        const net = this.playerNet(p); // 先取开战兵数（下面把队伍兵数归零）
        p.team.soldiers = 0; p.refresh(); // 兵力归零 → 本局失败（WorldScene / run 层）
        H.onPlayerWiped?.(p, { ...e, net: net && net.replace(/→\d+$/, '→0') }); break;
      }
    }
    return null;
  }

  /**
   * QA-14：玩家没赢的结局（脱离 / 溃逃后脱离 / 平局 / 无接触收兵 / 全军覆没）也在战报后面写「兵 开战前→现在」，
   * 开战前 = 战斗体 N0start（与 combat-end 的 start 相同），现在 = 战斗体兵数四舍五入（= 战斗结束后 HUD 的兵力）。
   * 参数里没有玩家队伍或玩家已没有战斗体 → ''。
   */
  playerNet(...ps) {
    const p = ps.find(x => x?.isPlayer || x?.team?.is_player), b = p && this.body(p.id);
    return b ? ` 兵${roundHalfUp(b.N0start ?? b.N0)}→${roundHalfUp(soldiersOf(b))}` : '';
  }

  _defeat(e, nowMs) {
    const L = this.parties.get(e.id), W = this.parties.get(e.by);
    if (!L) return null;
    const lb = { n: e.n };
    L.team.soldiers = roundHalfUp(lb.n);
    let outcome;
    if (W) {
      // 胜方战斗体可能已不在：同一 tick 胜方也被打败（互相打垮），melee.step 已移除它的战斗体 → 用 defeat 事件里记下的胜方兵数（byN / byN0）
      const wb = this.body(W.id);
      const wN = wb ? soldiersOf(wb) : (e.byN ?? W.team.soldiers), wN0 = wb ? (wb.N0start ?? wN) : (e.byN0 ?? wN);
      const wBefore = roundHalfUp(wN);
      W.team.soldiers = wBefore;
      const r = defeatResult(W.team, L.team, {
        R: e.E, power0: e.power0, playerShare: sharesOfPlayer(e.shares, this.parties),
        winnerLosses: roundHalfUp(Math.max(0, wN0 - wN)), loserDead: roundHalfUp(Math.max(0, (e.n0 ?? lb.n) - lb.n))
      }, this.balance);
      outcome = applyBattleResult(W.team, L.team, r, this.balance, this.rng);
      // 胜方仍可能在战斗中：收编按差值加到战斗体
      const delta = W.team.soldiers - wBefore;
      if (wb && delta) { wb.N0 = Math.max(0, (soldiersOf(wb) + delta) / Math.max(1e-9, 1 - wb.raw * (1 - wb.stats.red))); }
      if (wb) syncBodyFromTeam(wb, W.team, this.balance, this.cfg);
      W.refresh();
      outcome.points = r.playerPoints;
      if (r.playerPoints) outcome.text += ` +${r.playerPoints}分`;
      // QA-14：战报「损X」= 本次交战开始以来的阵亡（多队混战算全部敌人造成的），HUD 兵力还要加上「收编」、受兵力上限限制 → 玩家胜时把净变化写出来，两边对得上
      if (W.team.is_player) outcome.text += ` 兵${roundHalfUp(wN0)}→${W.team.soldiers}`;
      else if (L.team.is_player) outcome.text += ` 兵${roundHalfUp(e.n0 ?? lb.n)}→${L.team.soldiers}`; // 玩家败（旧路径；v0.5 起玩家走 player-wiped / 溃逃脱离）
      outcome.shares = e.shares;
    } else {
      outcome = { outcome: 'rout', removeIds: [L.id], captured: [], toFreePool: L.team.generals.filter(g => !g.generic).map(g => g.id), pendingGenerals: [], points: 0, text: `${L.name} 溃散${L.team.is_player ? ` 兵${roundHalfUp(e.n0 ?? lb.n)}→${L.team.soldiers}` : ''}` };
    }
    if (!outcome.removeIds.includes(L.id)) outcome.removeIds.push(L.id);
    const st = this.gameState;
    st.points += outcome.points ?? 0;
    st.freePool.push(...outcome.toFreePool);
    st.pendingGenerals.push(...outcome.pendingGenerals);
    for (const c of outcome.captured) if (c.to === 'player') st.captured.push(c.general);
    st.battles++;
    console.log(`[battle-end] ${outcome.text}`);
    this.hooks.onBattleEnd?.({ a: W ?? L, b: L }, outcome, e);
    return outcome;
  }

  serialize() { return structuredClone({ state: this.state, mem: this.mem }); }
}

function sharesOfPlayer(shares, parties) {
  for (const [id, v] of Object.entries(shares)) if (parties.get(id)?.isPlayer) return v;
  return 0;
}
