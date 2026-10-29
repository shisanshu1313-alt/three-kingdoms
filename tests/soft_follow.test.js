// 表现层软跟排：纯函数；不依赖 Phaser。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { softFollowStep, softTauFor, SOFT_FOLLOW_TAU } from '../src/render/partySprites.js';

test('leader tau=0 立即贴目标；soldier > deputy > 0', () => {
  assert.equal(softTauFor('leader'), 0);
  assert.ok(softTauFor('deputy') > 0);
  assert.ok(softTauFor('soldier', -6) >= SOFT_FOLLOW_TAU.soldier);
  assert.ok(softTauFor('soldier', -22) > softTauFor('soldier', -6));
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
  const melee = readFileSync(new URL('../src/systems/melee.js', import.meta.url), 'utf8');
  assert.match(melee, /turn_dps/);
  assert.match(melee, /accel_s/);
  // 不在 partySprites 里改战斗
  assert.doesNotMatch(decor, /turn_dps/);
});
