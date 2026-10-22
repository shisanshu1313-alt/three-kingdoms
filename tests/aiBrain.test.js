import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attitude, decide } from '../src/systems/aiBrain.js';

const load = f => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url)));
const balance = load('balance.json');
const cfg = balance.ai, P = cfg.personality;
const self = (over = {}) => ({ id: 'me', faction: 'wei', power: 100, x: 0, y: 0, home: { x: 0, y: 0 }, ...over });
const enemy = (over = {}) => ({ id: 'e', faction: 'shu', power: 100, x: 100, y: 0, isPlayer: false, invincible: false, inBattle: false, ...over });
const mem0 = { state: 'wander', targetId: null, since: 0, ignore: {} };
const run = (o) => decide({ cfg, personality: P.normal, now: 10, mem: mem0, ...o });

test('attitude 按性格阈值（我/敌）', () => {
  assert.equal(attitude(120, 100, P.normal), 'chase');   // 1.2 >= 1.2
  assert.equal(attitude(119, 100, P.normal), 'ignore');
  assert.equal(attitude(80, 100, P.normal), 'flee');     // 0.8 <= 0.8
  assert.equal(attitude(100, 100, P.aggressive), 'chase');
  assert.equal(attitude(100, 100, P.cautious), 'flee');  // 谨慎：势均力敌也跑
});

test('视野内弱敌 → 追击；视野外 → 游荡', () => {
  assert.deepEqual([run({ self: self({ power: 200 }), others: [enemy()] }).state], ['chase']);
  assert.equal(run({ self: self({ power: 200 }), others: [enemy({ x: cfg.vision_px + 1 })] }).state, 'wander');
});

test('强敌 → 逃跑，逃跑优先于追击', () => {
  const r = run({ self: self(), others: [enemy({ id: 'weak', power: 10, x: 50 }), enemy({ id: 'strong', power: 500, x: 200 })] });
  assert.equal(r.state, 'flee'); assert.equal(r.targetId, 'strong');
});

test('同阵营、战斗中、无敌玩家 不作为目标', () => {
  const s = self({ power: 999 });
  assert.equal(run({ self: s, others: [enemy({ faction: 'wei' })] }).state, 'wander');
  assert.equal(run({ self: s, others: [enemy({ inBattle: true })] }).state, 'wander');
  assert.equal(run({ self: s, others: [enemy({ id: 'player', isPlayer: true, invincible: true })] }).state, 'wander');
  assert.equal(run({ self: s, others: [enemy({ id: 'player', isPlayer: true })] }).targetId, 'player');
});

test('追击超距 / 超时 → 放弃并忽略目标 ignore_target_s', () => {
  const mem = { state: 'chase', targetId: 'e', since: 0, ignore: {} };
  const far = run({ self: self({ power: 999 }), others: [enemy({ x: cfg.chase_give_up_px + 1 })], mem, now: 1 });
  assert.notEqual(far.state, 'chase');
  assert.equal(far.ignore.e, 1 + cfg.ignore_target_s);
  const slow = run({ self: self({ power: 999 }), others: [enemy({ x: 50 })], mem, now: cfg.chase_max_s });
  assert.notEqual(slow.state, 'chase');
  // 忽略期内即使在视野里也不再追
  const again = run({ self: self({ power: 999 }), others: [enemy({ x: 50 })], mem: { ...mem0, ignore: slow.ignore }, now: cfg.chase_max_s + 1 });
  assert.equal(again.state, 'wander');
  const after = run({ self: self({ power: 999 }), others: [enemy({ x: 50 })], mem: { ...mem0, ignore: slow.ignore }, now: cfg.chase_max_s + cfg.ignore_target_s + 1 });
  assert.equal(after.state, 'chase');
});

test('追击中保持目标 & since 不重置', () => {
  const mem = { state: 'chase', targetId: 'e', since: 3, ignore: {} };
  const r = run({ self: self({ power: 999 }), others: [enemy({ x: 200 })], mem, now: 5 });
  assert.equal(r.state, 'chase'); assert.equal(r.since, 3);
});

test('逃到安全距离 / 超时 → 回家；离家太远且无事 → return', () => {
  const mem = { state: 'flee', targetId: 'e', since: 0, ignore: {} };
  assert.equal(run({ self: self(), others: [enemy({ power: 999, x: cfg.flee_safe_px })], mem, now: 1 }).state, 'return');
  assert.equal(run({ self: self(), others: [enemy({ power: 999, x: 200 })], mem, now: 1 }).state, 'flee');
  assert.equal(run({ self: self(), others: [enemy({ power: 999, x: 200 })], mem, now: cfg.flee_max_s }).state, 'return');
  const farHome = self({ x: cfg.wander_radius_px * cfg.return_home_radius_mult + 10 });
  assert.equal(run({ self: farHome, others: [] }).state, 'return');
});
