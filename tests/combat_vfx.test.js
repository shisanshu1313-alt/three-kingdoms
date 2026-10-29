// 战斗表现层：接触中点 / 常量；不依赖 Phaser。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contactMid, combatVfxConsts } from '../src/render/combatVfx.js';

test('contactMid：双方取中点；单方退回该点；都缺 → null', () => {
  assert.deepEqual(contactMid({ x: 0, y: 0 }, { x: 10, y: 20 }), { x: 5, y: 10 });
  assert.deepEqual(contactMid({ x: 3, y: 4 }, null), { x: 3, y: 4 });
  assert.equal(contactMid(null, null), null);
});

test('shake 窗在 80–120 ms；slash/dust 有节流常量', () => {
  assert.ok(combatVfxConsts.SHAKE_MS >= 80 && combatVfxConsts.SHAKE_MS <= 120);
  assert.ok(combatVfxConsts.SLASH_INTERVAL_MS > 0);
  assert.ok(combatVfxConsts.DUST_SPEED > 0);
});

test('WorldScene：impact/braced 调 burstContactFx；drawCombatFx 接 slash/dust', () => {
  const src = readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8');
  assert.match(src, /burstContactFx\(this, mid/);
  assert.match(src, /maybeContactSlash/);
  assert.match(src, /maybeFootDust/);
  assert.match(src, /combatEffect\(type, p, e\)/);
});
