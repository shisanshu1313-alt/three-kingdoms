// 表现层软跟排：纯函数；不依赖 Phaser。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  softFollowStep,
  softTauFor,
  SOFT_FOLLOW_TAU,
  TOPDOWN_V2B_TRY,
} from '../src/render/partySprites.js';

test('TOPDOWN 下 softTau：主将 0；副将/士兵非 0；后排 > 前排', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  assert.equal(softTauFor('leader'), 0);
  assert.equal(SOFT_FOLLOW_TAU.leader, 0);
  assert.ok(SOFT_FOLLOW_TAU.deputy >= 0.06 && SOFT_FOLLOW_TAU.deputy <= 0.10);
  assert.ok(SOFT_FOLLOW_TAU.soldier >= 0.12 && SOFT_FOLLOW_TAU.soldier <= 0.18);
  const dep = softTauFor('deputy');
  const front = softTauFor('soldier', -6);
  const rear = softTauFor('soldier', -22);
  assert.ok(dep > 0);
  assert.ok(front > 0);
  assert.ok(rear > front);
  assert.equal(dep, SOFT_FOLLOW_TAU.deputy);
  assert.equal(front, SOFT_FOLLOW_TAU.soldier);
});

test('softFollowStep：tau=0 贴目标；有 tau 则逼近不越过', () => {
  assert.deepEqual(softFollowStep(null, { x: 10, y: 20 }, 0.016, 0), { x: 10, y: 20 });
  const a = softFollowStep({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.05, 0.14);
  assert.ok(a.x > 0 && a.x < 10);
  assert.equal(a.y, 0);
  const b = softFollowStep(a, { x: 10, y: 0 }, 0.05, 0.14);
  assert.ok(b.x > a.x && b.x <= 10);
});

test('PartyDecor.sync 使用 softFollowStep；melee/combat 未改 turn/accel', () => {
  const decor = readFileSync(new URL('../src/render/partySprites.js', import.meta.url), 'utf8');
  assert.match(decor, /softFollowStep/);
  assert.match(decor, /softTauFor/);
  assert.doesNotMatch(decor, /TOPDOWN_V2B_TRY\)\s*return 0/);
  assert.match(decor, /SOFT_FOLLOW_TAU/);
  const melee = readFileSync(new URL('../src/systems/melee.js', import.meta.url), 'utf8');
  assert.match(melee, /turn_dps/);
  assert.match(melee, /accel_s/);
  // 不在 partySprites 里改战斗
  assert.doesNotMatch(decor, /turn_dps/);
});
