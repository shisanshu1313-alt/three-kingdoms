// 选中环在脚下、方旗抬升、真俯视固定槽位序：纯函数；不依赖 Phaser。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BANNER_LIFT,
  CAV_RING_SCALE_X,
  CAV_RING_SCALE_Y,
  CAV_RING_LIFT_Y,
  ringLayoutFor,
  decorDrawTier,
  compareDecorDrawOrder,
  compareDecorDrawOrderTopdown,
  compareDecorDrawOrderY,
  overlayDepthOffset,
  topdownSlotRank,
  topdownSpriteDepth,
  TOPDOWN_V2B_TRY,
  spriteOrigin,
  TRY_ORIGIN,
} from '../src/render/partySprites.js';

const fake = (y, ovKey, slotRank = 0, slotIndex = 0) => ({
  y,
  getData: (k) => {
    if (k === 'ovKey') return ovKey;
    if (k === 'slotRank') return slotRank;
    if (k === 'slotIndex') return slotIndex;
    return undefined;
  },
});

test('BANNER_LIFT：真俯视贴平面中心（旧侧视 -16）', () => {
  assert.equal(BANNER_LIFT, 0);
});

test('overlayDepthOffset：ring 在精灵下，其它挂件略上', () => {
  assert.ok(overlayDepthOffset('ring_player') < 0);
  assert.ok(overlayDepthOffset('ring_thin') < 0);
  assert.ok(overlayDepthOffset('ring_enemy') < 0);
  assert.ok(overlayDepthOffset('crown_named') > 0);
  assert.ok(overlayDepthOffset('banner_faction_player') > 0);
});

test('decorDrawTier：ring < sprite < 冠旗', () => {
  assert.equal(decorDrawTier(fake(0, 'ring_player')), 0);
  assert.equal(decorDrawTier(fake(0, undefined)), 1);
  assert.equal(decorDrawTier(fake(0, 'crown_named')), 2);
});

test('topdownSlotRank / topdownSpriteDepth：主将 > 副将 > 士兵，不用 y', () => {
  assert.equal(topdownSlotRank('soldier'), 0);
  assert.equal(topdownSlotRank('deputy'), 1);
  assert.equal(topdownSlotRank('leader'), 2);
  assert.ok(topdownSpriteDepth(0, 'leader') > topdownSpriteDepth(0, 'deputy'));
  assert.ok(topdownSpriteDepth(0, 'deputy') > topdownSpriteDepth(0, 'soldier'));
  assert.ok(topdownSpriteDepth(2, 'soldier') > topdownSpriteDepth(1, 'soldier'));
});

test('compareDecorDrawOrderTopdown：全体 ring 底、冠旗顶；同层主将在士兵上', () => {
  const ringLead = fake(99, 'ring_player', 2, 0);   // 南边主将环
  const ringSol = fake(-99, 'ring_thin', 0, 3);      // 北边士兵环
  const sprLead = fake(-50, undefined, 2, 0);
  const sprSol = fake(50, undefined, 0, 3);
  const sprDep = fake(0, undefined, 1, 1);
  const crown = fake(-80, 'crown_named', 2, 0);
  const banner = fake(80, 'banner_faction_player', 2, 0);

  const ordered = [crown, sprLead, ringLead, sprSol, banner, ringSol, sprDep]
    .sort(compareDecorDrawOrderTopdown);

  // 两环最先（y 无关）
  assert.equal(decorDrawTier(ordered[0]), 0);
  assert.equal(decorDrawTier(ordered[1]), 0);
  // 本体：士兵 → 副将 → 主将
  const bodies = ordered.filter((o) => decorDrawTier(o) === 1);
  assert.deepEqual(bodies.map((o) => o.getData('slotRank')), [0, 1, 2]);
  // 冠旗最后
  assert.equal(decorDrawTier(ordered[ordered.length - 2]), 2);
  assert.equal(decorDrawTier(ordered[ordered.length - 1]), 2);

  // 转向后 y 互换也不改序
  const a = fake(100, undefined, 0, 1);
  const b = fake(-100, undefined, 2, 0);
  assert.ok(compareDecorDrawOrderTopdown(a, b) < 0, '士兵本体仍在主将下');
});

test('compareDecorDrawOrderY：偏南（大 y）仍优先（旧侧视回退路径）', () => {
  const south = fake(10, 'ring_enemy');
  const north = fake(0, 'crown_named');
  assert.ok(compareDecorDrawOrderY(north, south) < 0);
  const ring = fake(5, 'ring_thin');
  const spr = fake(5, undefined);
  const crown = fake(5, 'crown_named');
  const ordered = [crown, spr, ring].sort(compareDecorDrawOrderY);
  assert.deepEqual(ordered.map((o) => decorDrawTier(o)), [0, 1, 2]);
});

test('compareDecorDrawOrder：TRY 开启时走真俯视固定序', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  const sprSol = fake(100, undefined, 0, 2);
  const sprLead = fake(-100, undefined, 2, 0);
  assert.ok(compareDecorDrawOrder(sprSol, sprLead) < 0);
  const ring = fake(999, 'ring_player', 2, 0);
  const crown = fake(-999, 'crown_named', 2, 0);
  assert.ok(compareDecorDrawOrder(ring, crown) < 0);
});

test('PartyDecor.sync 使用 compareDecorDrawOrder + overlayDepthOffset + topdown depth', () => {
  const src = readFileSync(new URL('../src/render/partySprites.js', import.meta.url), 'utf8');
  assert.match(src, /compareDecorDrawOrder/);
  assert.match(src, /overlayDepthOffset/);
  assert.match(src, /topdownSpriteDepth/);
  assert.match(src, /小维真俯视/);
  assert.match(src, /ring_/);
});

test('ringLayoutFor：步战同 scale；骑兵更宽更扁并下移（美工 5203）', () => {
  assert.equal(CAV_RING_SCALE_X, 1.3);
  assert.equal(CAV_RING_SCALE_Y, 0.7);
  assert.equal(CAV_RING_LIFT_Y, 10);
  const lead = 1.55;
  const inf = ringLayoutFor('inf', lead);
  assert.deepEqual(inf, { scaleX: lead, scaleY: lead, liftY: 0 });
  const spr = ringLayoutFor('spr', 1);
  assert.deepEqual(spr, { scaleX: 1, scaleY: 1, liftY: 0 });
  const cav = ringLayoutFor('cav', lead);
  assert.ok(Math.abs(cav.scaleX - lead * CAV_RING_SCALE_X) < 1e-9);
  assert.ok(Math.abs(cav.scaleY - lead * CAV_RING_SCALE_Y) < 1e-9);
  // TRY 开启：中心锚点，不再为侧视马肚下移
  assert.equal(cav.liftY, 0);
  assert.ok(cav.scaleX > cav.scaleY, 'cavalry ring flatter');
  assert.ok(cav.scaleY < lead, 'cavalry ring shorter than unit scale');
  assert.equal(CAV_RING_LIFT_Y, 10); // 常量保留给回退侧视
});

test('PartyDecor rebuild/sync 对 ring_ 调用 ringLayoutFor', () => {
  const js = readFileSync(new URL('../src/render/partySprites.js', import.meta.url), 'utf8');
  assert.match(js, /ringLayoutFor/);
  assert.match(js, /CAV_RING_SCALE_X/);
  assert.match(js, /startsWith\('ring_'\)/);
});

test('真俯视 spriteOrigin 平面中心 (0.5, 0.5)', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  assert.deepEqual(spriteOrigin(), { x: 0.5, y: 0.5 });
  assert.deepEqual(TRY_ORIGIN, { x: 0.5, y: 0.5 });
  const js = readFileSync(new URL('../src/render/partySprites.js', import.meta.url), 'utf8');
  assert.match(js, /spriteOrigin\(\)/);
  assert.match(js, /setOrigin\(org\.x, org\.y\)/);
});
