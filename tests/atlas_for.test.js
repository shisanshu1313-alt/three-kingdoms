// 兵种 atlas 映射 + 缺图回退；npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atlasFor, atlasCandidates, ATLAS_MATRIX, buildPartySpritePlan, TOPDOWN_V2B_TRY } from '../src/render/partySprites.js';

test('atlasFor 首选：inf/spr/arc/cav 士兵与骑将', () => {
  assert.equal(atlasFor('inf', 'soldier'), 'soldier_inf');
  assert.equal(atlasFor('spr', 'soldier'), 'soldier_spr');
  assert.equal(atlasFor('arc', 'soldier'), 'soldier_arc');
  assert.equal(atlasFor('cav', 'soldier'), 'soldier_cav');
  assert.equal(atlasFor('cav', 'deputy'), 'officer_cav');
  assert.equal(atlasFor('cav', 'leader'), 'named_cav');
  assert.equal(atlasFor('inf', 'leader'), 'named_base');
});

test('TRY 开启：士兵不回退侧视 melee/bow；将官仍可用 named_base/officer', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  const legacy = new Set(['soldier_melee', 'soldier_bow', 'officer', 'named_base']);
  const ex = (k) => legacy.has(k);
  // 士兵：首选剪影 key（即使缺图也不用 melee/bow）
  assert.equal(atlasFor('inf', 'soldier', ex), 'soldier_inf');
  assert.equal(atlasFor('spr', 'soldier', ex), 'soldier_spr');
  assert.equal(atlasFor('arc', 'soldier', ex), 'soldier_arc');
  assert.equal(atlasFor('cav', 'soldier', ex), 'soldier_cav');
  // 将官候选含 officer/named_base（同属 TOPDOWN_TRY_KEYS）
  assert.equal(atlasFor('cav', 'deputy', ex), 'officer');
  assert.equal(atlasFor('cav', 'leader', ex), 'named_base');
});

test('buildPartySpritePlan 按 unit 选 atlas；exists 回退', () => {
  const team = { id: 'p', is_player: true, unit: 'cav', soldiers: 20, generals: [{ id: 'a' }], faction: 'player' };
  const pref = buildPartySpritePlan(team);
  assert.equal(pref.entries.find(e => e.role === 'leader').atlas, 'named_cav');
  assert.equal(pref.entries.find(e => e.role === 'soldier').atlas, 'soldier_cav');
  const legacy = new Set(['soldier_melee', 'soldier_bow', 'officer', 'named_base']);
  const fb = buildPartySpritePlan(team, { exists: (k) => legacy.has(k) });
  assert.equal(fb.entries.find(e => e.role === 'leader').atlas, 'named_base');
  // TRY：士兵坚持 soldier_cav，不落 melee
  assert.equal(fb.entries.find(e => e.role === 'soldier').atlas, 'soldier_cav');
});

test('atlasCandidates：TRY 下士兵无 melee/bow；矩阵四兵种齐全', () => {
  assert.equal(TOPDOWN_V2B_TRY, true);
  assert.deepEqual(atlasCandidates('arc', 'soldier'), ['soldier_arc']);
  assert.deepEqual(atlasCandidates('inf', 'soldier'), ['soldier_inf']);
  assert.ok(!atlasCandidates('arc', 'soldier').includes('soldier_bow'));
  assert.ok(!atlasCandidates('inf', 'soldier').includes('soldier_melee'));
  assert.deepEqual(Object.keys(ATLAS_MATRIX).sort(), ['arc', 'cav', 'inf', 'spr']);
});
