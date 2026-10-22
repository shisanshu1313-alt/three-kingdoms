import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addGeneralOrQueue, resolvePending, replaceableIndices } from '../src/systems/roster.js';
import { createGameState } from '../src/systems/gameState.js';
import { indexBalance } from '../src/systems/teams.js';
import { computePower, soldierCap, mainGeneral } from '../src/systems/combat.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const idx = indexBalance(balance);
const G = id => ({ ...idx.generalsById[id] });
const full = () => ({ id: 'player', is_player: true, soldiers: 50, generals: [{ ...balance.hero }, G('liaohua'), { id: 'p_gen', name: '波才', generic: true, lead: 30, str: 40, int: 20, cha: 20 }], items: [] });

test('未满直接入队，满编排队（先进先出）', () => {
  const s = createGameState(balance), t = { generals: [{ ...balance.hero }], items: [] };
  assert.equal(addGeneralOrQueue(s, t, G('lvbu'), { source: 'capture' }, balance).joined, true);
  const f = full();
  addGeneralOrQueue(s, f, G('zhaoyun'), { source: 'gacha', from: '抽卡' }, balance);
  addGeneralOrQueue(s, f, G('lvbu'), { source: 'capture', from: '吕布军' }, balance);
  assert.deepEqual(s.pendingGenerals.map(p => p.general.id), ['zhaoyun', 'lvbu']);
});

test('主角不可替换', () => {
  assert.deepEqual(replaceableIndices(full(), balance), [1, 2]);
  const s = createGameState(balance), t = full();
  s.pendingGenerals.push({ general: G('lvbu'), source: 'capture' });
  assert.throws(() => resolvePending(s, t, 'replace', 0, balance));
});

test('替换：新将入队；被替换名将回自由池、头目消失；战力/上限随之变化', () => {
  const s = createGameState(balance), t = full();
  const p0 = computePower(t, balance), c0 = soldierCap(t, balance);
  s.pendingGenerals.push({ general: G('zhaoyun'), source: 'gacha' }, { general: G('lvbu'), source: 'capture' });
  const r1 = resolvePending(s, t, 'replace', 1, balance);
  assert.equal(r1.replaced.id, 'liaohua'); assert.ok(s.freePool.includes('liaohua'));
  assert.equal(t.generals[1].id, 'zhaoyun');
  assert.equal(mainGeneral(t, balance).id, 'zhaoyun'); // 统率最高
  assert.ok(computePower(t, balance) > p0 && soldierCap(t, balance) > c0);
  const poolLen = s.freePool.length;
  resolvePending(s, t, 'replace', 2, balance); // 替换黄巾头目
  assert.equal(s.freePool.length, poolLen); // 头目不进自由池
  assert.deepEqual(t.generals.map(g => g.id), ['hero', 'zhaoyun', 'lvbu']);
  assert.equal(s.pendingGenerals.length, 0);
});

test('释放：名将回自由池，+release_captive_points；头目消失', () => {
  const s = createGameState(balance), t = full();
  s.pendingGenerals.push({ general: G('lvbu'), source: 'capture' }, { general: { id: 'x', name: '管亥', generic: true, lead: 1, str: 1, int: 1, cha: 1 }, source: 'capture' });
  const r = resolvePending(s, t, 'release', null, balance);
  assert.equal(r.points, balance.rewards.release_captive_points);
  assert.equal(s.points, 20); assert.ok(s.freePool.includes('lvbu'));
  resolvePending(s, t, 'release', null, balance);
  assert.ok(!s.freePool.includes('x')); assert.equal(s.points, 40);
  assert.equal(t.generals.length, 3);
});
