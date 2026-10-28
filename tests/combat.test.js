// 数值公式单测：npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { computePower, soldierCap, teamSpeed, lossReduction, resolveCombat, captureChance, victoryPoints, drawPoints, roundHalfUp } from '../src/systems/combat.js';
import { buildTeam, indexBalance, createNameAllocator, teamName } from '../src/systems/teams.js';
import { mulberry32 } from '../src/systems/rng.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const idx = indexBalance(balance);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const team = (over = {}) => ({ id: 't', faction: 'wei', is_player: false, soldiers: 100, generals: [], items: [], position: { x: 0, y: 0 }, ...over });

// 单测不读工作区 design/（CI 里没有）：比对仓库里的副本 tests/fixtures/balance_v0.4.json（策划改版时同步复制）
const DESIGN = new URL('./fixtures/balance_v0.4.json', import.meta.url);
test('balance.json 与 tests/fixtures/balance_v0.4.json（策划配置副本）一致（忘记 npm run sync:balance 会失败）', () => {
  const src = JSON.parse(readFileSync(DESIGN));
  assert.deepEqual(balance, src);
  assert.equal(balance._meta.version, '0.4');
});

test('computePower：team_example = 63.6', () => {
  near(computePower(structuredClone(balance.team_example), balance), 63.6, 1e-9);
});

test('soldierCap / teamSpeed（兵数项下限 0.6，乘物品后不再截断）', () => {
  const t = team({ soldiers: 200, generals: [{ lead: 50, str: 1, int: 100, cha: 1 }, { lead: 30, str: 1, int: 10, cha: 1 }], items: ['supply_cart', 'fine_horse'] });
  assert.equal(soldierCap(t, balance), 100 + 2 * 80 + 60);
  near(teamSpeed(t, balance), 100 * (1 - 0.0005 * 200) * 1.15);
  near(teamSpeed(team({ soldiers: 5000, items: ['fine_horse'] }), balance), 100 * 0.6 * 1.15);
});

test('lossReduction：智力部分封顶 0.30，加兵书，总和封顶 loss_reduction_total_cap', () => {
  near(lossReduction(team({ generals: [{ int: 100 }], items: ['art_of_war'] }), balance), 0.38);
  near(lossReduction(team({ generals: [{ int: 50 }] }), balance), 0.15);
  const many = team({ generals: [{ int: 100 }], items: ['art_of_war', 'art_of_war', 'art_of_war'] }); // 0.3+0.24 → 0.5
  near(lossReduction(many, balance), balance.power.loss_reduction_total_cap);
});

test('俘获率按该武将自身魅力计算', () => {
  const w = team({ generals: [{ cha: 80 }] });
  near(captureChance(w, { cha: 20 }, 1, balance), 0.3 + 0.004 * 60);
  near(captureChance(w, { cha: 80 }, 1, balance), 0.3);
  near(captureChance(w, { cha: 0 }, 50, balance), balance.rewards.capture_max);
});

test('平局：R < draw_ratio，双方各自 round(N×draw_loss×(1−减免))；非玩家对战仍 0 分', () => {
  const g = { lead: 50, str: 50, int: 0, cha: 50 };
  const r = resolveCombat(team({ id: 'a', generals: [g] }), team({ id: 'b', generals: [g] }), balance, null, { rolls: [1, 1] });
  assert.equal(r.outcome, 'draw');
  assert.equal(r.a.losses, 20);
  assert.equal(r.points, 0);
  near(r.duration_s, Math.min(8, 1.5 + 6 / 1));
});


test('R3-E1：玩家平局 → roundHalfUp(0.5 × points_win)；points_win 同胜利公式', () => {
  const g = { lead: 50, str: 50, int: 0, cha: 50 };
  const a = team({ id: 'player', is_player: true, generals: [g] });
  const b = team({ id: 'b', generals: [g] });
  const r = resolveCombat(a, b, balance, null, { rolls: [1, 1] });
  assert.equal(r.outcome, 'draw');
  const enemyPanel = r.b.power; // 战前面板
  const expectWin = victoryPoints(enemyPanel, r.ratio, balance);
  const expectDraw = roundHalfUp(0.5 * expectWin);
  assert.equal(r.points, expectDraw);
  assert.ok(r.points > 0);
  // 对称：玩家在 b 侧
  const r2 = resolveCombat(b, a, balance, null, { rolls: [1, 1] });
  assert.equal(r2.outcome, 'draw');
  assert.equal(r2.points, expectDraw);
});

test('R3-E1：AI 间平局 / 玩家战败仍 0 分；drawPoints 默认 mult=0.5', () => {
  const g = { lead: 50, str: 50, int: 0, cha: 50 };
  const r = resolveCombat(team({ id: 'a', generals: [g] }), team({ id: 'b', generals: [g] }), balance, null, { rolls: [1, 1] });
  assert.equal(r.outcome, 'draw');
  assert.equal(r.points, 0);
  // drawPoints 无 v06 时默认 0.5
  assert.equal(drawPoints(100, 1, balance), roundHalfUp(0.5 * victoryPoints(100, 1, balance)));
  // 显式 draw_mult
  const bal = { ...balance, rewards: balance.rewards, v06: { tuning: { draw_points: { draw_mult: 0.5 } } } };
  assert.equal(drawPoints(40, 1, bal), roundHalfUp(0.5 * victoryPoints(40, 1, bal)));
});

test('每方独立掷随机：rng 被调用两次（先 a 后 b）', () => {
  const seq = [0, 1]; let i = 0;
  const r = resolveCombat(structuredClone(balance.team_example), team({ id: 'b', generals: [{ lead: 40, str: 45, int: 40, cha: 50 }], soldiers: 30, items: ['war_drum'] }), balance, () => seq[i++]);
  assert.equal(i, 2);
  near(r.a.roll, balance.battle.random_min); near(r.b.roll, balance.battle.random_max);
  assert.equal(r.winner, 'b');
});

test('AI 间战斗 / AI 胜：0 分', () => {
  const r = resolveCombat(team({ id: 'a', soldiers: 200, generals: [{ lead: 50, str: 50, int: 50, cha: 50 }] }),
    team({ id: 'b', faction: 'shu', soldiers: 20, generals: [{ lead: 50, str: 50, int: 50, cha: 50 }] }), balance, null, { rolls: [1, 1] });
  assert.equal(r.winner, 'a'); assert.equal(r.points, 0);
});

test('initial_teams 全部可构建、无警告、兵不超上限、名字按规则', () => {
  const rng = mulberry32(1), nextName = createNameAllocator(balance, rng);
  const names = new Set();
  for (const def of balance.initial_teams) {
    const { team: t, warnings } = buildTeam(def, balance, rng, idx, nextName);
    assert.deepEqual(warnings, [], def.id);
    assert.ok(t.soldiers <= soldierCap(t, balance), `${def.id} 兵力超上限`);
    assert.equal(t.name, teamName(t, balance, idx));
    names.add(t.name);
    if (def.position === 'home') assert.deepEqual(t.position, idx.factionsById[def.faction].home);
    if (def.faction === 'bandit') assert.ok(t.name.startsWith('黄巾军·') && balance.ai.bandit_name_pool.includes(t.generals[0].name));
  }
  assert.equal(names.size, balance.initial_teams.length, '队名不重复');
  const player = balance.initial_teams.find(d => d.id === 'player');
  assert.deepEqual(player.position, balance.player_faction.start);
});

test('黄巾名字池不放回，用尽后「黄巾头目N」', () => {
  const next = createNameAllocator(balance, mulberry32(3));
  const got = Array.from({ length: balance.ai.bandit_name_pool.length + 2 }, next);
  assert.equal(new Set(got).size, got.length);
  assert.deepEqual(got.slice(-2), ['黄巾头目1', '黄巾头目2']);
});

test('阵营 home 与城池坐标对齐', () => {
  const cities = Object.fromEntries(balance.cities.map(c => [c.id, c]));
  for (const f of balance.ai.factions) if (f.home_city) {
    assert.deepEqual(f.home, cities[f.home_city].px);
    const c = cities[f.home_city];
    assert.deepEqual(c.px, { x: c.tile.x * balance.map.tile_px + 16, y: c.tile.y * balance.map.tile_px + 16 });
  }
});
