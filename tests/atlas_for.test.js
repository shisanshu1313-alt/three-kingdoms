// 兵种 atlas 映射 + 缺图回退；npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atlasFor, atlasCandidates, ATLAS_MATRIX, buildPartySpritePlan } from '../src/render/partySprites.js';

test('atlasFor 首选：inf/spr/arc/cav 士兵与骑将', () => {
  assert.equal(atlasFor('inf', 'soldier'), 'soldier_inf');
  assert.equal(atlasFor('spr', 'soldier'), 'soldier_spr');
  assert.equal(atlasFor('arc', 'soldier'), 'soldier_arc');
  assert.equal(atlasFor('cav', 'soldier'), 'soldier_cav');
  assert.equal(atlasFor('cav', 'deputy'), 'officer_cav');
  assert.equal(atlasFor('cav', 'leader'), 'named_cav');
  assert.equal(atlasFor('inf', 'leader'), 'named_base');
});

test('缺图回退：只有旧 atlas 时用 melee/bow/officer/named_base', () => {
  const legacy = new Set(['soldier_melee', 'soldier_bow', 'officer', 'named_base']);
  const ex = (k) => legacy.has(k);
  assert.equal(atlasFor('inf', 'soldier', ex), 'soldier_melee');
  assert.equal(atlasFor('spr', 'soldier', ex), 'soldier_melee');
  assert.equal(atlasFor('arc', 'soldier', ex), 'soldier_bow');
  assert.equal(atlasFor('cav', 'soldier', ex), 'soldier_melee');
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
  assert.equal(fb.entries.find(e => e.role === 'soldier').atlas, 'soldier_melee');
});

test('atlasCandidates 含回退链', () => {
  assert.ok(atlasCandidates('arc', 'soldier').includes('soldier_bow'));
  assert.deepEqual(Object.keys(ATLAS_MATRIX).sort(), ['arc', 'cav', 'inf', 'spr']);
});
