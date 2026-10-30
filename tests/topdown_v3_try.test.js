/**
 * topdown_s3d 试玩挂载：旁路图集 + 八向 + TRY_SCALE（不推线上约定由程序侧保证）
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
  BANNER_LIFT,
  spriteOrigin,
  atlasCandidates,
  HIDE_FACTION_BANNER_TRY,
  HIDE_SELECTION_RING_TRY,
  SELECTION_RING_KEYS,
  overlayKeysVisible,
  buildPartySpritePlan,
  TOPDOWN_BANNER_KEYS,
  TRY_FORMATION_SPACING,
  TRY_FORMATION_SPACING_LATERAL,
  TRY_FORMATION_SPACING_FORWARD,
} from '../src/render/partySprites.js';

const SRC = readFileSync(new URL('../src/render/partySprites.js', import.meta.url), 'utf8');

test('TOPDOWN_V2B_TRY 标志与 TRY_SCALE≈1.5', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  assert.ok(TRY_SCALE >= 1.45 && TRY_SCALE <= 1.55);
  assert.ok(Math.abs(TRY_SCALE - 1.5) < 1e-9);
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

test('preload：silhouette → atlas_topdown_s3d；melee/bow → atlas；banner → overlays_topdown_v4', () => {
  assert.match(SRC, /atlas_topdown_s3d/);
  assert.match(SRC, /overlays_topdown_v4/);
  assert.match(SRC, /TOPDOWN_TRY_KEYS/);
  assert.match(SRC, /TOPDOWN_BANNER_KEYS/);
  const loads = [];
  const images = [];
  const scene = {
    load: {
      atlas(k, png, json) { loads.push({ k, png, json }); },
      image(k, png) { images.push({ k, png }); },
    },
  };
  preloadPartyAssets(scene);
  const byKey = Object.fromEntries(loads.map(l => [l.k, l]));
  for (const k of TOPDOWN_TRY_KEYS) {
    assert.ok(byKey[k], k);
    assert.match(byKey[k].png, /atlas_topdown_s3d\//);
    assert.match(byKey[k].json, /atlas_topdown_s3d\//);
  }
  assert.match(byKey.soldier_melee.png, /\/atlas\/soldier_melee/);
  assert.match(byKey.soldier_bow.png, /\/atlas\/soldier_bow/);
  assert.ok(!byKey.soldier_melee.png.includes('atlas_topdown_s3d'));
  assert.ok(!byKey.soldier_bow.png.includes('atlas_topdown_s3d'));
  const byImg = Object.fromEntries(images.map(l => [l.k, l]));
  for (const k of ['banner_faction_player', 'banner_faction_enemy', 'banner_t2']) {
    assert.match(byImg[k].png, /overlays_topdown_v4\//);
  }
  assert.match(byImg.ring_player.png, /\/overlays\/ring_player/);
});

test('ensurePartyAnims 缺帧跳过（源码锁）', () => {
  assert.match(SRC, /atlasHasFrame/);
  assert.match(SRC, /frames\.every\(f => atlasHasFrame/);
  assert.match(SRC, /idleFrameFor/);
});

test('public atlas_topdown_s3d 八 key + overlays_topdown_v4 扁旗就位', () => {
  const base = new URL('../public/assets/sprites/parties/atlas_topdown_s3d/', import.meta.url);
  for (const k of TOPDOWN_TRY_KEYS) {
    assert.ok(existsSync(new URL(`${k}.png`, base)), `${k}.png`);
    assert.ok(existsSync(new URL(`${k}.json`, base)), `${k}.json`);
  }
  const ov = new URL('../public/assets/sprites/parties/overlays_topdown_v4/', import.meta.url);
  for (const k of ['banner_faction_player', 'banner_faction_enemy', 'banner_t2']) {
    assert.ok(existsSync(new URL(`${k}.png`, ov)), `${k}.png`);
  }
});

test('真俯视：固定槽位序 + softTau>0（转向浅弧）', () => {
  assert.match(SRC, /compareDecorDrawOrderTopdown/);
  assert.match(SRC, /topdownSpriteDepth/);
  assert.match(SRC, /小维真俯视/);
  assert.doesNotMatch(SRC, /TOPDOWN_V2B_TRY\)\s*return 0/);
  assert.ok(softTauFor('soldier', -22) > 0);
  assert.ok(softTauFor('deputy') > 0);
  assert.equal(softTauFor('leader'), 0);
  const fake = (ovKey, rank, idx) => ({
    y: 0,
    getData: (k) => (k === 'ovKey' ? ovKey : k === 'slotRank' ? rank : k === 'slotIndex' ? idx : undefined),
  });
  const ordered = [fake(undefined, 2, 0), fake(undefined, 0, 1)].sort(compareDecorDrawOrderTopdown);
  assert.equal(ordered[0].getData('slotRank'), 0);
  assert.equal(ordered[1].getData('slotRank'), 2);
});

test('真俯视渲染：origin 中心 + BANNER_LIFT=0 + 士兵无 melee/bow 回退', () => {
  assert.equal(BANNER_LIFT, 0);
  assert.deepEqual(spriteOrigin(), { x: 0.5, y: 0.5 });
  assert.deepEqual(atlasCandidates('cav', 'soldier'), ['soldier_cav']);
  assert.ok(!atlasCandidates('arc', 'soldier').includes('soldier_bow'));
  assert.match(SRC, /TRY_ORIGIN/);
  assert.match(SRC, /spriteOrigin/);
});

test('TOPDOWN try：HIDE_FACTION_BANNER_TRY 不画势力旗/banner overlay', () => {
  assert.equal(HIDE_FACTION_BANNER_TRY, true);
  assert.equal(TOPDOWN_V2B_TRY, true);
  assert.deepEqual(
    overlayKeysVisible(['ring_player', 'crown_named', 'banner_faction_player', 'banner_t2']),
    ['crown_named'],
  );
  for (const k of TOPDOWN_BANNER_KEYS) {
    assert.equal(overlayKeysVisible([k]).length, 0, k);
  }
  const team = {
    id: 'p', is_player: true, unit: 'inf', soldiers: 80, faction: 'player',
    generals: [{ id: 'h' }, { id: 'd1' }, { id: 'd2' }],
  };
  const plan = buildPartySpritePlan(team);
  const allOv = plan.entries.flatMap((e) => e.overlays || []);
  for (const k of ['banner_faction_player', 'banner_faction_enemy', 'banner_t2']) {
    assert.ok(!allOv.includes(k), `plan must not include ${k}`);
  }
  assert.ok(allOv.includes('crown_named') || allOv.includes('crest_t1'));
  assert.match(SRC, /HIDE_FACTION_BANNER_TRY/);
  assert.match(SRC, /overlayKeysVisible/);
});

test('TOPDOWN try：HIDE_SELECTION_RING_TRY 不画选中环 ring_*', () => {
  assert.equal(HIDE_SELECTION_RING_TRY, true);
  assert.equal(TOPDOWN_V2B_TRY, true);
  for (const k of SELECTION_RING_KEYS) {
    assert.equal(overlayKeysVisible([k]).length, 0, k);
  }
  assert.deepEqual(overlayKeysVisible(['ring_player', 'crown_named', 'crest_t1']), ['crown_named', 'crest_t1']);
  const team = {
    id: 'p', is_player: true, unit: 'cav', soldiers: 80, faction: 'player',
    generals: [{ id: 'h' }, { id: 'd1' }],
  };
  const plan = buildPartySpritePlan(team);
  const allOv = plan.entries.flatMap((e) => e.overlays || []);
  for (const k of ['ring_player', 'ring_thin', 'ring_enemy']) {
    assert.ok(!allOv.includes(k), `plan must not include ${k}`);
  }
  assert.match(SRC, /HIDE_SELECTION_RING_TRY/);
  assert.match(SRC, /SELECTION_RING_KEYS/);
});

test('TOPDOWN try：前后×6.2 / 左右×7.2 拉开编队槽位（仅 draw）', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  assert.ok(Math.abs(TRY_FORMATION_SPACING_LATERAL - 7.2) < 1e-9);
  assert.ok(Math.abs(TRY_FORMATION_SPACING_FORWARD - 6.2) < 1e-9);
  assert.ok(Math.abs(TRY_FORMATION_SPACING - TRY_FORMATION_SPACING_LATERAL) < 1e-9);
  const team = {
    id: 'p', is_player: true, unit: 'inf', soldiers: 40, faction: 'player',
    generals: [{ id: 'h' }, { id: 'd1' }, { id: 'd2' }],
  };
  const plan = buildPartySpritePlan(team);
  const lead = plan.entries.find((e) => e.role === 'leader');
  const dep = plan.entries.find((e) => e.role === 'deputy');
  // formation.json leader.forward=19, deputy_0.right=-10
  assert.ok(Math.abs(lead.forward - 19 * TRY_FORMATION_SPACING_FORWARD) < 1e-9);
  assert.ok(Math.abs(dep.right - (-10) * TRY_FORMATION_SPACING_LATERAL) < 1e-9);
  assert.match(SRC, /TRY_FORMATION_SPACING_FORWARD/);
  assert.match(SRC, /TRY_FORMATION_SPACING_LATERAL/);
});
