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

test('TOPDOWN_V2B_TRY 时 softTauFor 全 0（真俯视关软跟拖影）', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  assert.equal(softTauFor('leader'), 0);
  assert.equal(softTauFor('deputy'), 0);
  assert.equal(softTauFor('soldier', -6), 0);
  assert.equal(softTauFor('soldier', -22), 0);
  // 侧视表仍保留，供标志关闭时回退
  assert.ok(SOFT_FOLLOW_TAU.soldier > 0);
  assert.ok(SOFT_FOLLOW_TAU.deputy > 0);
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
  assert.match(decor, /TOPDOWN_V2B_TRY\)\s*return 0/);
  const melee = readFileSync(new URL('../src/systems/melee.js', import.meta.url), 'utf8');
  assert.match(melee, /turn_dps/);
  assert.match(melee, /accel_s/);
  // 不在 partySprites 里改战斗
  assert.doesNotMatch(decor, /turn_dps/);
});
