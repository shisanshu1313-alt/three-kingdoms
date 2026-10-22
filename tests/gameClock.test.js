import { test } from 'node:test';
import assert from 'node:assert/strict';
import GameClock from '../src/core/GameClock.js';

test('tick 推进游戏时间；暂停时不推进', () => {
  const c = new GameClock(1000);
  c.tick(16); assert.equal(c.now, 1016);
  c.pause(); c.tick(5000); assert.equal(c.now, 1016);
  c.resume(); c.tick(4); assert.equal(c.now, 1020);
  c.tick(-5); c.tick(NaN); assert.equal(c.now, 1020);
});

test('定时器按游戏时间触发；暂停期间不触发、剩余时间不变', () => {
  const c = new GameClock(), hits = [];
  c.every('respawn', 1000, now => hits.push(now));
  c.tick(600); assert.equal(c.remaining('respawn'), 400);
  c.pause(); for (let i = 0; i < 100; i++) c.tick(1000);
  assert.deepEqual(hits, []); assert.equal(c.remaining('respawn'), 400);
  c.resume(); c.tick(400); assert.deepEqual(hits, [1000]);
  c.tick(2500); assert.deepEqual(hits, [1000, 3500, 3500]); // 一次大 tick 补触发 2000、3000 两次（回调收到当前时间）
  assert.equal(c.remaining('respawn'), 500);
});

test('多个定时器按到期顺序触发；cancel 后不再触发', () => {
  const c = new GameClock(), order = [];
  c.every('a', 300, () => order.push('a'));
  c.every('b', 200, () => order.push('b'));
  c.tick(600);
  assert.deepEqual(order, ['b', 'a', 'b', 'a', 'b']); // 同时到期按注册顺序
  c.cancel('a'); order.length = 0; c.tick(600);
  assert.deepEqual(order, ['b', 'b', 'b']);
});

test('截止时间（无敌/冷却/战斗结束）用游戏时间判断：暂停期间不会过期', () => {
  const c = new GameClock(0);
  const invincibleUntil = c.now + 8000, battleEndAt = c.now + 3000;
  c.tick(2000); c.pause(); c.tick(60000);
  assert.ok(c.now < battleEndAt && c.now < invincibleUntil);
  c.resume(); c.tick(1000); assert.ok(c.now >= battleEndAt && c.now < invincibleUntil);
});

test('getState / firstAt：存档后恢复，定时器在同一游戏时间触发', () => {
  const c = new GameClock(); c.every('autosave', 30000, () => {}); c.every('respawn', 8000, () => {});
  c.tick(12345);
  const st = JSON.parse(JSON.stringify(c.getState()));
  assert.deepEqual(st, { now: 12345, timers: { autosave: 30000, respawn: 16000 } });
  const d = new GameClock(st.now), hits = [];
  d.every('respawn', 8000, now => hits.push(now), st.timers.respawn);
  d.tick(3654); assert.deepEqual(hits, []); d.tick(1); assert.deepEqual(hits, [16000]);
});
