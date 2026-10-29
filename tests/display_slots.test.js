// 策划 display_slots 终稿：generalCount / soldier_budget / W=[1,10,100,500] 压缩 / 队形副将空位。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displaySlots, generalCountOf, soldierTierList, SOLDIER_WEIGHTS, TOTAL_SPRITE_SOFT_CAP } from '../src/systems/displaySlots.js';
import { buildPartySpritePlan, localOffset, facingDir, TRY_FORMATION_SPACING, TRY_FORMATION_SPACING_LATERAL, TOPDOWN_V2B_TRY } from '../src/render/partySprites.js';
import formation from '../src/data/partyFormation.json' with { type: 'json' };

const g = n => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, name: `将${i}` }));

test('权重与软顶常量', () => {
  assert.deepEqual([...SOLDIER_WEIGHTS], [1, 10, 100, 500]);
  assert.equal(TOTAL_SPRITE_SOFT_CAP, 8);
});

test('generalCount = clamp(len, 1, 3)；空数组也按 1', () => {
  assert.equal(generalCountOf([]), 1);
  assert.equal(generalCountOf(null), 1);
  assert.equal(generalCountOf(g(1)), 1);
  assert.equal(generalCountOf(g(2)), 2);
  assert.equal(generalCountOf(g(3)), 3);
  assert.equal(generalCountOf(g(5)), 3);
});

test('soldier_budget = 8 - generalCount；空副将位不占预算', () => {
  assert.equal(displaySlots(0, g(1)).soldier_budget, 7);
  assert.equal(displaySlots(0, g(2)).soldier_budget, 6);
  assert.equal(displaySlots(0, g(3)).soldier_budget, 5);
  // 1 名副将时 empty_deputy_slot=1，但 budget 仍按 generalCount=2 → 6，不因空位再减
  const s = displaySlots(20, g(2));
  assert.equal(s.deputies, 1);
  assert.equal(s.empty_deputy_slot, 1);
  assert.equal(s.soldier_budget, 6);
});

test('lead 恒为 1；deputies = generalCount-1；empty_deputy_slot 仅在 1 副将时为 1', () => {
  const a = displaySlots(10, g(1));
  assert.equal(a.lead, 1);
  assert.equal(a.deputies, 0);
  assert.equal(a.empty_deputy_slot, 0);
  const b = displaySlots(10, g(2));
  assert.equal(b.deputies, 1);
  assert.equal(b.empty_deputy_slot, 1);
  const c = displaySlots(10, g(3));
  assert.equal(c.deputies, 2);
  assert.equal(c.empty_deputy_slot, 0);
});

test('兵力 0 → 全 0；≥1 且压缩后全 0 → t0=1', () => {
  const z = displaySlots(0, g(1));
  assert.deepEqual([z.t0, z.t1, z.t2, z.t3], [0, 0, 0, 0]);
  const one = displaySlots(1, g(1));
  assert.equal(one.t0 + one.t1 + one.t2 + one.t3 >= 1, true);
  assert.equal(one.t0, 1);
});

test('小兵力不压缩：5 兵 1 将 → t0=5', () => {
  const s = displaySlots(5, g(1));
  assert.deepEqual([s.t0, s.t1, s.t2, s.t3], [5, 0, 0, 0]);
  assert.ok(s.t0 + s.t1 + s.t2 + s.t3 <= s.soldier_budget);
});

test('位权先拆：500/700 兵出 T3（g=1 与 g=3）', () => {
  // N=500 g=1 → t3=1（不是 t2=5）
  const a = displaySlots(500, g(1));
  assert.deepEqual([a.t0, a.t1, a.t2, a.t3], [0, 0, 0, 1]);
  // N=700 g=1 → t3=1 + t2=2
  const b = displaySlots(700, g(1));
  assert.deepEqual([b.t0, b.t1, b.t2, b.t3], [0, 0, 2, 1]);
  // g=3 时 budget=5，500/700 拆后仍 ≤5，结果相同
  const c = displaySlots(500, g(3));
  assert.deepEqual([c.t0, c.t1, c.t2, c.t3], [0, 0, 0, 1]);
  const d = displaySlots(700, g(3));
  assert.deepEqual([d.t0, d.t1, d.t2, d.t3], [0, 0, 2, 1]);
});

test('超预算优先 10→1：25 兵预算 7 → 先合成再必要时抬档', () => {
  const s = displaySlots(25, g(1)); // budget 7
  assert.ok(s.t0 + s.t1 + s.t2 + s.t3 <= 7);
  // 25：10+10+5 → t1=2,t0=5（和=7）刚好贴预算
  assert.deepEqual([s.t0, s.t1, s.t2, s.t3], [5, 2, 0, 0]);
});

test('超预算且不足 10：整档抬升（略夸张）', () => {
  // 8 兵、预算 7 → t0=8 >7，不能 10 合 1，整档抬 → t1=1
  const s = displaySlots(8, g(1));
  assert.deepEqual([s.t0, s.t1, s.t2, s.t3], [0, 1, 0, 0]);
  assert.ok(s.t0 + s.t1 + s.t2 + s.t3 <= s.soldier_budget);
});

test('总精灵 generalCount + Σt ≤ 8', () => {
  for (const n of [0, 1, 7, 8, 9, 25, 99, 250, 500, 1200, 9999]) {
    for (const gc of [1, 2, 3]) {
      const s = displaySlots(n, g(gc));
      const total = s.generalCount + s.t0 + s.t1 + s.t2 + s.t3;
      assert.ok(total <= 8, `n=${n} gc=${gc} total=${total} ${JSON.stringify(s)}`);
    }
  }
});

test('soldierTierList 高档在前', () => {
  assert.deepEqual(soldierTierList({ t0: 2, t1: 1, t2: 0, t3: 1 }), [3, 1, 0, 0]);
});

test('队形：0 副将士兵前移；1 副将留空位间距；2 副将都画', () => {
  const t0 = { id: 'p', is_player: true, unit: 'inf', soldiers: 12, generals: g(1), faction: 'player' };
  const t1 = { ...t0, generals: g(2) };
  const t2 = { ...t0, generals: g(3) };
  const p0 = buildPartySpritePlan(t0);
  const p1 = buildPartySpritePlan(t1);
  const p2 = buildPartySpritePlan(t2);
  assert.equal(p0.slots.deputies, 0);
  assert.ok(p0.shiftFwd > 0, '0 副将应前移');
  assert.equal(p0.entries.filter(e => e.role === 'deputy').length, 0);
  assert.equal(p1.slots.deputies, 1);
  assert.equal(p1.slots.empty_deputy_slot, 1);
  assert.equal(p1.shiftFwd, 0);
  assert.equal(p1.entries.filter(e => e.role === 'deputy').length, 1);
  // 唯一副将在 deputy_0（左），右位留空；TOPDOWN try 时乘 TRY_FORMATION_SPACING_LATERAL（左右）
  const expectRight = formation.slots.deputy_0.local_offset_px.right * (TOPDOWN_V2B_TRY ? TRY_FORMATION_SPACING_LATERAL : 1);
  assert.equal(p1.entries.find(e => e.role === 'deputy').right, expectRight);
  assert.equal(p2.slots.deputies, 2);
  assert.equal(p2.entries.filter(e => e.role === 'deputy').length, 2);
  assert.equal(p2.shiftFwd, 0);
  // 每人有且仅有 1 个 lead
  for (const p of [p0, p1, p2]) assert.equal(p.entries.filter(e => e.role === 'leader').length, 1);
});

test('localOffset 面朝南时与 formation.screen_offset_facing_s 一致', () => {
  const h = Math.PI / 2; // 南
  for (const [name, slot] of Object.entries(formation.slots)) {
    if (name === 'soldier_slots') continue;
    const o = localOffset(h, slot.local_offset_px.forward, slot.local_offset_px.right);
    assert.ok(Math.abs(o.x - slot.screen_offset_facing_s.x) < 1e-6, name);
    assert.ok(Math.abs(o.y - slot.screen_offset_facing_s.y) < 1e-6, name);
  }
  const s0 = formation.slots.soldier_slots[0];
  const o = localOffset(h, s0.local_offset_px.forward, s0.local_offset_px.right);
  assert.ok(Math.abs(o.x - s0.screen_offset_facing_s.x) < 1e-6);
  assert.ok(Math.abs(o.y - s0.screen_offset_facing_s.y) < 1e-6);
});

test('facingDir 八向（cardinal + diagonal）', () => {
  assert.equal(facingDir(0), 'e');
  assert.equal(facingDir(Math.PI / 2), 's');
  assert.equal(facingDir(Math.PI), 'w');
  assert.equal(facingDir(-Math.PI / 2), 'n');
  assert.equal(facingDir(Math.PI / 4), 'se');
  assert.equal(facingDir(Math.PI * 3 / 4), 'sw');
  assert.equal(facingDir(Math.PI * 5 / 4), 'nw');
  assert.equal(facingDir(Math.PI * 7 / 4), 'ne');
});

test('标签兵数不受 display_slots 压缩影响（文档约定：HUD 精确值）', () => {
  // 纯约定锁：displaySlots 改变的是精灵档，不是 soldiers 本身
  const soldiers = 87;
  const s = displaySlots(soldiers, g(2));
  const spriteN = s.t0 + s.t1 + s.t2 + s.t3;
  assert.ok(spriteN < soldiers);
  assert.equal(soldiers, 87);
});
