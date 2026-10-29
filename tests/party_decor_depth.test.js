// 选中环在脚下、方旗抬升：纯函数；不依赖 Phaser。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BANNER_LIFT,
  decorDrawTier,
  compareDecorDrawOrder,
  overlayDepthOffset,
} from '../src/render/partySprites.js';

const fake = (y, ovKey) => ({
  y,
  getData: (k) => (k === 'ovKey' ? ovKey : undefined),
});

test('BANNER_LIFT：美工 5202/cav 抬至 -16（不改骑位间距）', () => {
  assert.equal(BANNER_LIFT, -16);
});

test('overlayDepthOffset：ring 在精灵下，其它挂件略上', () => {
  assert.ok(overlayDepthOffset('ring_player') < 0);
  assert.ok(overlayDepthOffset('ring_thin') < 0);
  assert.ok(overlayDepthOffset('ring_enemy') < 0);
  assert.ok(overlayDepthOffset('crown_named') > 0);
  assert.ok(overlayDepthOffset('banner_faction_player') > 0);
});

test('decorDrawTier / compareDecorDrawOrder：同 y 时 ring < sprite < 冠旗', () => {
  assert.equal(decorDrawTier(fake(0, 'ring_player')), 0);
  assert.equal(decorDrawTier(fake(0, undefined)), 1);
  assert.equal(decorDrawTier(fake(0, 'crown_named')), 2);
  const ring = fake(5, 'ring_thin');
  const spr = fake(5, undefined);
  const crown = fake(5, 'crown_named');
  const ordered = [crown, spr, ring].sort(compareDecorDrawOrder);
  assert.deepEqual(ordered.map((o) => decorDrawTier(o)), [0, 1, 2]);
  // 偏南（大 y）仍优先
  const south = fake(10, 'ring_enemy');
  const north = fake(0, 'crown_named');
  assert.ok(compareDecorDrawOrder(north, south) < 0);
});

test('PartyDecor.sync 使用 compareDecorDrawOrder + overlayDepthOffset', () => {
  const src = readFileSync(new URL('../src/render/partySprites.js', import.meta.url), 'utf8');
  assert.match(src, /compareDecorDrawOrder/);
  assert.match(src, /overlayDepthOffset/);
  assert.match(src, /ring_/);
});
