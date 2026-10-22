// 存档决定 1 / 3：抽卡与战斗用存档里的随机数流 → 读档不能重掷；抽卡后的未完成选择随存档保存、读档后继续
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pull, resolveAttrChoice, resolveItemFull, resultFromPending, canPull } from '../src/systems/gacha.js';
import { resolveCombat } from '../src/systems/combat.js';
import { applyBattleResult } from '../src/systems/battle.js';
import { buildTeam, indexBalance } from '../src/systems/teams.js';
import { createGameState } from '../src/systems/gameState.js';
import { mulberry32 } from '../src/systems/rng.js';
import { makeSave, serialize, parseSave, restoreGameState } from '../src/systems/save.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const idx = indexBalance(balance);
const ctx = { balance, mapSeed: 184 };
const hero = () => ({ id: 'hero', name: balance.hero.name, lead: 40, str: 45, int: 40, cha: 50 });
const G = id => { const b = idx.generalsById[id]; return { id: b.id, name: b.name, tier: b.tier, lead: b.lead, str: b.str, int: b.int, cha: b.cha }; };
const POOL = balance.gacha.pool, TOTAL = POOL.reduce((s, e) => s + e.weight, 0);
const rollFor = type => { let acc = 0; for (const e of POOL) { if (e.type === type) return (acc + e.weight / 2) / TOTAL; acc += e.weight; } };

/** 极简“游戏”：state + 玩家队 + gacha 随机数流；save/load 走真实的存档编码 */
function newGame(seed) {
  const state = createGameState(balance); state.points = 100000;
  const team = { id: 'player', faction: 'player', is_player: true, soldiers: 30, generals: [hero(), G('liaohua')], items: ['war_drum'], position: { x: 1600, y: 1100 }, home: { x: 1600, y: 1100 } };
  return { state, team, rng: mulberry32(seed) };
}
function saveLoad(g) {
  const snap = { gameTimeMs: 0, state: g.state, player: { team: g.team }, ai: [], spawn: { counter: 0 }, names: { pool: [], n: 0 }, rng: { gacha: g.rng.getState() }, run: { runId: 'r', heroHp: 100, chapter: 0, namedDefeated: [] } };
  const { save } = parseSave(serialize(makeSave(snap, { balance, mapSeed: 184 })), ctx);
  const rng = mulberry32(0); rng.setState(save.rng.gacha);
  return { state: restoreGameState(save.state, createGameState(balance)), team: save.player.team, rng };
}
/** 抽 n 次，自动处理选择（选第 1 个可选武将 / 放弃新物品 / 清空待安排） */
function pullN(g, n, out = []) {
  for (let i = 0; i < n; i++) {
    const r = pull(g.state, g.team, balance, g.rng);
    out.push([r.type, r.general?.id ?? r.item?.id ?? r.attr?.attr ?? null, r.next]);
    if (g.state.gachaPending?.next === 'choose_general') out.push(['chose', resolveAttrChoice(g.state, g.team, resultFromPending(g.state, g.team, balance).targets[0], balance, g.rng).attr]);
    if (g.state.gachaPending?.next === 'item_full') resolveItemFull(g.state, g.team, resultFromPending(g.state, g.team, balance).item, null, balance);
    g.state.pendingGenerals.length = 0;
  }
  return out;
}

test('读档不能重掷抽卡：抽一半存档读档再抽，与一直不读档的结果完全相同', () => {
  const a = newGame(77); const resA = pullN(a, 40);
  let b = newGame(77); const resB = pullN(b, 17); b = saveLoad(b); pullN(b, 23, resB);
  assert.deepEqual(resB, resA);
  assert.equal(b.state.points, a.state.points); assert.deepEqual(b.state.freePool, a.state.freePool);
  assert.deepEqual(b.team.generals, a.team.generals); assert.deepEqual(b.team.items, a.team.items);
});

test('抽卡后立即存档：读档看到的就是已扣点、已出结果的状态（不回滚），反复读档结果也不变', () => {
  const g = newGame(5);
  const r = pull(g.state, g.team, balance, g.rng);
  const after = { points: g.state.points, draws: g.state.gachaDraws };
  const l1 = saveLoad(g), l2 = saveLoad(g);
  assert.deepEqual({ points: l1.state.points, draws: l1.state.gachaDraws }, after);
  assert.deepEqual(pull(l1.state, l1.team, balance, l1.rng), pull(l2.state, l2.team, balance, l2.rng)); // 两次读档后下一抽相同
  void r;
});

test('未完成的选择（选武将）存档后读档重新出现，选完与不读档的结果一致', () => {
  const g = newGame(1);
  pull(g.state, g.team, balance, () => rollFor('attr_big')); // 两名可选 → 等选择
  assert.equal(g.state.gachaPending.next, 'choose_general');
  assert.equal(canPull(g.state, g.team, balance).reason, 'pending');
  const l = saveLoad(g);
  const res = resultFromPending(l.state, l.team, balance);
  assert.equal(res.next, 'choose_general'); assert.deepEqual(res.targets, [0, 1]); assert.equal(res.amount, 5);
  const before = { ...l.team.generals[1] };
  const upL = resolveAttrChoice(l.state, l.team, 1, balance, l.rng);
  const upG = resolveAttrChoice(g.state, g.team, 1, balance, g.rng);
  assert.deepEqual(upL, upG); assert.equal(l.state.gachaPending, null);
  assert.equal(l.team.generals[1][upL.attr], before[upL.attr] + 5);
});

test('未完成的选择（物品栏满）存档后读档重新出现', () => {
  const g = newGame(1); g.team.items = ['war_drum', 'fine_horse', 'banner'];
  const iIdx = balance.items.findIndex(i => !g.team.items.includes(i.id));
  const seq = [rollFor('item'), (iIdx + 0.5) / balance.items.length]; let k = 0;
  pull(g.state, g.team, balance, () => seq[k++]);
  assert.equal(g.state.gachaPending.next, 'item_full');
  const l = saveLoad(g);
  const res = resultFromPending(l.state, l.team, balance);
  assert.equal(res.item.id, balance.items[iIdx].id);
  resolveItemFull(l.state, l.team, res.item, 0, balance);
  assert.equal(l.team.items[0], balance.items[iIdx].id); assert.equal(l.state.gachaPending, null);
});

test('读档不能重掷战斗：开战前存下 combat 随机数状态，读档后同一场战斗结果（含俘获）完全相同', () => {
  const mk = () => {
    const p = buildTeam({ id: 'player', faction: 'player', is_player: true, soldiers: 120, generals: ['hero', 'zhaoyun'], items: [], position: { x: 0, y: 0 } }, balance, () => 0.5, idx, () => 'x').team;
    const e = buildTeam({ id: 'e', faction: 'qun', soldiers: 40, generals: ['huaxiong', 'liaohua'], items: [], position: { x: 0, y: 0 } }, balance, () => 0.5, idx, () => 'x').team;
    return [p, e];
  };
  const rng = mulberry32(99);
  for (let i = 0; i < 5; i++) rng();
  const saved = JSON.parse(JSON.stringify(rng.getState()));
  const fight = (r) => { const [p, e] = mk(); const res = resolveCombat(p, e, balance, r); const out = applyBattleResult(p, e, res, balance, r); return { res, captured: out.captured.map(c => c.general.id), p: p.soldiers }; };
  const first = fight(rng);
  const r2 = mulberry32(1); r2.setState(saved);
  assert.deepEqual(fight(r2), first);
});
