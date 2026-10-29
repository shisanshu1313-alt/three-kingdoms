/**
 * topdown_v2b 试玩挂载：旁路图集 + 八向 + TRY_SCALE（不推线上约定由程序侧保证）
 */
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  facingDir,
  DIRS,
  TRY_SCALE,
  TOPDOWN_TRY_KEYS,
  TOPDOWN_V2B_TRY,
  preloadPartyAssets,
  compareDecorDrawOrderTopdown,
  softTauFor,
} from '../src/render/partySprites.js';

const SRC = readFileSync(new URL('../src/render/partySprites.js', import.meta.url), 'utf8');

test('TOPDOWN_V2B_TRY 标志与 TRY_SCALE≈1.35', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  assert.ok(TRY_SCALE >= 1.25 && TRY_SCALE <= 1.5);
  assert.ok(Math.abs(TRY_SCALE - 1.35) < 1e-9);
});

test('DIRS 八向顺序含对角', () => {
  assert.deepEqual(DIRS, ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw']);
});

test('facingDir 边界落在扇区中线附近', () => {
  // 东扇区中心 0；东南中心 π/4
  assert.equal(facingDir(0.01), 'e');
  assert.equal(facingDir(Math.PI / 4), 'se');
  assert.equal(facingDir(Math.PI / 2 - 0.01), 's');
});

test('preload：silhouette → atlas_topdown_v2b；melee/bow → atlas', () => {
  assert.match(SRC, /atlas_topdown_v2b/);
  assert.match(SRC, /TOPDOWN_TRY_KEYS/);
  const loads = [];
  const scene = {
    load: {
      atlas(k, png, json) { loads.push({ k, png, json }); },
      image() {},
    },
  };
  preloadPartyAssets(scene);
  const byKey = Object.fromEntries(loads.map(l => [l.k, l]));
  for (const k of TOPDOWN_TRY_KEYS) {
    assert.ok(byKey[k], k);
    assert.match(byKey[k].png, /atlas_topdown_v2b\//);
    assert.match(byKey[k].json, /atlas_topdown_v2b\//);
  }
  assert.match(byKey.soldier_melee.png, /\/atlas\/soldier_melee/);
  assert.match(byKey.soldier_bow.png, /\/atlas\/soldier_bow/);
  assert.ok(!byKey.soldier_melee.png.includes('atlas_topdown_v2b'));
  assert.ok(!byKey.soldier_bow.png.includes('atlas_topdown_v2b'));
});

test('ensurePartyAnims 缺帧跳过（源码锁）', () => {
  assert.match(SRC, /atlasHasFrame/);
  assert.match(SRC, /frames\.every\(f => atlasHasFrame/);
  assert.match(SRC, /idleFrameFor/);
});

test('public atlas_topdown_v2b 八 key 就位', () => {
  const base = new URL('../public/assets/sprites/parties/atlas_topdown_v2b/', import.meta.url);
  for (const k of TOPDOWN_TRY_KEYS) {
    assert.ok(existsSync(new URL(`${k}.png`, base)), `${k}.png`);
    assert.ok(existsSync(new URL(`${k}.json`, base)), `${k}.json`);
  }
});

test('真俯视：固定槽位序 + softTau=0（源码锁）', () => {
  assert.match(SRC, /compareDecorDrawOrderTopdown/);
  assert.match(SRC, /topdownSpriteDepth/);
  assert.match(SRC, /小维真俯视/);
  assert.equal(softTauFor('soldier', -22), 0);
  const fake = (ovKey, rank, idx) => ({
    y: 0,
    getData: (k) => (k === 'ovKey' ? ovKey : k === 'slotRank' ? rank : k === 'slotIndex' ? idx : undefined),
  });
  const ordered = [fake(undefined, 2, 0), fake(undefined, 0, 1)].sort(compareDecorDrawOrderTopdown);
  assert.equal(ordered[0].getData('slotRank'), 0);
  assert.equal(ordered[1].getData('slotRank'), 2);
});
