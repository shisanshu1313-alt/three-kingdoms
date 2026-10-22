import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveCombat, soldierCap, computePower } from '../src/systems/combat.js';
import { applyBattleResult } from '../src/systems/battle.js';
import { buildRespawnTeam, indexBalance, createNameAllocator } from '../src/systems/teams.js';
import { mulberry32 } from '../src/systems/rng.js';

const load = f => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url)));
const balance = load('balance.json'), asm = load('assumptions.json').battle;
const idx = indexBalance(balance);
const G = id => structuredClone(idx.generalsById[id]);
const team = (over = {}) => ({ id: 't', name: 't', faction: 'wei', is_player: false, soldiers: 100, generals: [], items: [], position: { x: 0, y: 0 }, ...over });
const fixed = v => () => v;
const R1 = { rolls: [1, 1] };

test('AI 胜 AI：胜方兵 = min(上限, N−损+收编)；败方解散；未被俘名将回自由池', () => {
  const w = team({ id: 'w', soldiers: 150, generals: [G('caocao')] });
  const l = team({ id: 'l', faction: 'shu', soldiers: 40, generals: [G('liaohua')], items: ['banner'] });
  const r = resolveCombat(w, l, balance, null, R1);
  const o = applyBattleResult(w, l, r, balance, asm, fixed(0.99)); // 不俘获
  assert.equal(o.winnerId, 'w');
  assert.deepEqual(o.removeIds, ['l']);
  assert.equal(w.soldiers, Math.min(soldierCap(w, balance), 150 - r.winnerLosses + r.recruited));
  assert.equal(r.recruited, Math.floor(r.loserSurvivors * r.recruitRate));
  assert.deepEqual(o.toFreePool, ['liaohua']);
  assert.equal(o.points, 0);
});

test('AI 胜方俘获：有空位入队，满编名将回自由池', () => {
  const w = team({ id: 'w', soldiers: 150, generals: [G('caocao')] });
  const l = team({ id: 'l', faction: 'shu', soldiers: 20, generals: [G('liaohua')] });
  const o = applyBattleResult(w, l, resolveCombat(w, l, balance, null, R1), balance, asm, fixed(0));
  assert.deepEqual(w.generals.map(g => g.id), ['caocao', 'liaohua']);
  assert.deepEqual(o.toFreePool, []);
  const full = team({ id: 'f', soldiers: 300, generals: [G('caocao'), G('xiahoudun'), G('zhouyu')] });
  const l2 = team({ id: 'l2', faction: 'shu', soldiers: 20, generals: [G('liaohua')] });
  const o2 = applyBattleResult(full, l2, resolveCombat(full, l2, balance, null, R1), balance, asm, fixed(0));
  assert.equal(full.generals.length, 3);
  assert.deepEqual(o2.toFreePool, ['liaohua']);
});

test('玩家胜：积分 round；俘获的武将入队（保留属性）；满编进待处理', () => {
  const p = team({ id: 'player', faction: 'player', is_player: true, soldiers: 150, generals: [{ ...balance.hero, cha: 90 }] });
  const e = team({ id: 'e', faction: 'qun', soldiers: 20, generals: [{ ...G('huaxiong'), str: 95 }] });
  const r = resolveCombat(p, e, balance, null, R1);
  const o = applyBattleResult(p, e, r, balance, asm, fixed(0));
  assert.ok(Number.isInteger(o.points) && o.points > 0);
  assert.equal(p.generals[1].id, 'huaxiong'); assert.equal(p.generals[1].str, 95);
  const p2 = team({ id: 'player', faction: 'player', is_player: true, soldiers: 300, generals: [{ ...balance.hero }, G('zhaoyun'), G('zhangfei')] });
  const e2 = team({ id: 'e2', faction: 'qun', soldiers: 20, generals: [G('huaxiong')] });
  const o2 = applyBattleResult(p2, e2, resolveCombat(p2, e2, balance, null, R1), balance, asm, fixed(0));
  assert.deepEqual(o2.pendingCaptives.map(g => g.id), ['huaxiong']);
});

test('玩家战败：kept = max(5, floor(溃兵×0.5))；主角不被俘；随从按自身魅力可被俘', () => {
  const p = team({ id: 'player', faction: 'player', is_player: true, soldiers: 30, generals: [{ ...balance.hero }, G('liaohua')] });
  const e = team({ id: 'e', soldiers: 200, generals: [G('lvbu')] });
  const r = resolveCombat(p, e, balance, null, R1);
  assert.equal(r.capture.hero, 0);
  assert.ok(r.capture.liaohua > 0);
  const o = applyBattleResult(p, e, r, balance, asm, fixed(0));
  assert.deepEqual(p.generals.map(g => g.id), ['hero']);
  assert.equal(p.soldiers, Math.max(5, Math.floor(r.loserSurvivors * 0.5)));
  assert.equal(r.recruitBase, Math.max(0, r.loserSurvivors - p.soldiers));
  assert.equal(o.playerDefeat.invincible_s, balance.battle.player_defeat.invincible_s);
});

test('平局：双方扣兵，推开距离与冷却来自配置', () => {
  const g = { lead: 50, str: 50, int: 0, cha: 50 };
  const a = team({ id: 'a', generals: [g] }), b = team({ id: 'b', faction: 'shu', generals: [g] });
  const r = resolveCombat(a, b, balance, null, R1);
  const o = applyBattleResult(a, b, r, balance, asm);
  assert.equal(o.outcome, 'draw');
  assert.equal(a.soldiers, 100 - r.a.losses);
  assert.equal(o.pushback_px, balance.battle.draw_pushback_px);
  assert.equal(o.pair_cooldown_s, balance.battle.draw_pair_cooldown_s);
});

test('补充刷新：黄巾、战力≈玩家×U(power_vs_player)、兵数按公式', () => {
  const rng = mulberry32(5), nextName = createNameAllocator(balance, rng);
  const [lo, hi] = balance.spawn.power_vs_player;
  for (let i = 0; i < 20; i++) {
    const t = buildRespawnTeam({ id: `s${i}`, position: { x: 0, y: 0 }, playerPower: 100, balance, rng, nextName });
    assert.equal(t.faction, balance.spawn.faction);
    assert.ok(t.name.startsWith('黄巾军·'));
    const pw = computePower(t, balance);
    assert.ok(pw >= 100 * lo - 3 && pw <= 100 * hi + 3, `power ${pw}`);
    assert.ok(t.soldiers >= balance.spawn.min_soldiers);
    assert.deepEqual(t.home, t.position); // 黄巾 home = 出生点
  }
});
