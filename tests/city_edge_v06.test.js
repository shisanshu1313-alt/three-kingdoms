// 策划 2026-10-23 city_v06 三条边界规则：stronger_hint（严格大于）/ siege.chapter_change / siege.regen_rule。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balance } from '../src/data/index.js';
import combatJson from '../src/data/combat_v05.json' with { type: 'json' };
import { buildV06 } from '../scripts/sync-v06.mjs';
import { createCities, cityTick, cityLabel, applyChapter, defMax, siegeDps } from '../src/systems/city.js';

const design = JSON.parse(readFileSync(new URL('./fixtures/balance_v0.6.json', import.meta.url), 'utf8'));
const move = combatJson.move;
const ctx = (over = {}) => ({ tS: 0, dt: 0.1, chapter: 0, balance, move, homeCity: null, ...over });
const C = balance.v06.city;

test('配置：三条规则按策划字段名同步（city_v06.garrison.power_recalc.stronger_hint / siege.chapter_change / siege.regen_rule）', () => {
  assert.match(design.city_v06.garrison.power_recalc.stronger_hint, /严格大于/);
  assert.match(design.city_v06.siege.chapter_change, /当前城防值不变/);
  assert.match(design.city_v06.siege.regen_rule, /回复倒计时就暂停/);
  const v = buildV06(design);
  assert.equal(v.city.garrison.stronger_hint, 'gt'); assert.equal(v.city.chapter_change, 'keep'); assert.equal(v.city.regen_rule, 'away');
  assert.equal(v.city.break_window_s, 20);
  assert.deepEqual([C.garrison.stronger_hint, C.chapter_change, C.regen_rule], ['gt', 'keep', 'away'], 'src/data/v06.json 已同步');
  // 没有这些字段（旧定稿）→ 旧行为
  const old = structuredClone(design);
  delete old.city_v06.siege.regen_rule; old.city_v06.siege.chapter_change = '换章时城防上限换成新章数值，当前城防按比例放大';
  const o = buildV06(old);
  assert.equal(o.city.chapter_change, 'scale'); assert.equal(o.city.regen_rule, 'since_zero');
});

test('规则 1「强于你」：标签战力 > 玩家战力（严格大于，按显示的整数）才提示；相等不提示', () => {
  const L = createCities(balance).luoyang, max = 230, warn = (g, p) => cityLabel(L, { max, garrisonPower: g, playerPower: p, strongerHint: C.garrison.stronger_hint }).text.includes('强于你');
  assert.equal(warn(70, 70), false, '相等不提示');
  assert.equal(warn(70, 69.6), false, '显示都是 70 → 相等');
  assert.equal(warn(70.4, 70), false);
  assert.equal(warn(71, 70), true);
  assert.equal(warn(70, 69.4), true, '70 > 69');
  assert.equal(cityLabel(L, { max, garrisonPower: 71, playerPower: 70 }).color, '#ff7777');
  assert.equal(cityLabel(L, { max, garrisonPower: 70, playerPower: 70 }).color, '#ffffff');
});

test('规则 2 换章：攻城中每秒城防伤害上限立即换成新章「城防上限 ÷ 15」，当前城防值不变（不补满）', () => {
  const cs = createCities(balance), L = cs.luoyang, m = balance.v06.tuning.siege_min_s;
  assert.equal(m, 15);
  const pl = { id: 'player', isPlayer: true, faction: 'player', x: L.x, y: L.y + 50, r: 15, unit: 'inf', power: 2000, soldiers: 100 };
  assert.ok(siegeDps(pl.power, pl.unit, balance) > defMax(balance, 1) / m, '攻方伤害远超上限 → 被上限截断');
  let t = 0;
  for (let i = 0; i < 50; i++) cityTick(cs, [pl], ctx({ tS: t = +(t + 0.1).toFixed(3) }));
  assert.ok(Math.abs(L.def - (230 - 5 * 230 / 15)) < 1e-6, `第 1 章 5 s 扣 5 × 230/15（${L.def}）`);
  const before = L.def;
  applyChapter(cs, 1, balance);
  assert.equal(L.def, before, '换章：当前城防不变，不按 420 补满 / 不按比例放大');
  cityTick(cs, [pl], ctx({ tS: t = +(t + 0.1).toFixed(3), chapter: 1 }));
  assert.ok(Math.abs(before - L.def - 0.1 * 420 / 15) < 1e-6, `换章后下一 tick 就按 420/15 扣（${before - L.def}）`);
  assert.equal(cs.xuchang.def, 420, '没被打过的满城防城 → 新章上限');
});

test('规则 3 城防回复：城防 0 后玩家贴着城 / 正在和守军交战 → 倒计时暂停；离开且不交战满 20 s 才开始回复，之后要重新破城', () => {
  const cs = createCities(balance), L = cs.luoyang;
  const pl = { id: 'player', isPlayer: true, faction: 'player', x: L.x, y: L.y + 50, r: 15, unit: 'inf', power: 2000, soldiers: 100 };
  let t = 0;
  const tick = (n, o = {}) => { for (let i = 0; i < n; i++) cityTick(cs, [pl], ctx({ tS: t = +(t + 0.1).toFixed(3), ...o })); };
  tick(200); assert.equal(L.def, 0, '破城');
  tick(400); assert.equal(L.def, 0, '玩家一直贴着城 40 s：不回复');
  pl.x = L.x + 500; // 离开城，但还在和守军交战
  tick(300, { playerFightingGarrison: ['luoyang'] }); assert.equal(L.def, 0, '离开城但在和守军交战 30 s：不回复');
  tick(195); assert.equal(L.def, 0, '不贴城、不交战 19.5 s：还是 0');
  pl.x = L.x; pl.y = L.y + 50; tick(1); pl.x = L.x + 500; // 中途回来贴一下 → 重新计 20 s
  tick(195); assert.equal(L.def, 0, '回来过：离开时间重新计');
  tick(4); assert.equal(L.def, 0, "19.9 s：还是 0");
  tick(20); assert.ok(L.def > 0 && L.def < 230 * 0.03 * 2.1, `连续离开满 20 s → 开始回复（${L.def}）`);
  tick(20); const d = L.def; assert.ok(d > 0);
  // 回复之后城防 > 0：要重新破城（玩家再贴上来 = 攻城，按上限扣）
  pl.x = L.x; pl.y = L.y + 50; tick(1); assert.ok(L.def < d && L.def >= 0);
});

test('规则 3：玩家自己的主城被 AI 攻破 → AI 贴着城时不回复；AI 走开满 20 s 后回复（玩家在城里不影响）', () => {
  const cs = createCities(balance), L = cs.luoyang; L.owner = 'player'; L.garrison = null; L.def = 0; L.zeroAtS = 0; L.zeroAwayS = 0; L.lastHitS = 0;
  const ai = { id: 'w', faction: 'wei', x: L.x, y: L.y + 50, r: 15, unit: 'inf', power: 100, soldiers: 50, siegeTarget: 'luoyang' };
  const me = { id: 'player', isPlayer: true, faction: 'player', x: L.x, y: L.y, r: 15, unit: 'inf', power: 100, soldiers: 50 };
  let t = 0;
  const tick = (n, ps) => { for (let i = 0; i < n; i++) cityTick(cs, ps, ctx({ tS: t = +(t + 0.1).toFixed(3), homeCity: 'luoyang' })); };
  tick(300, [ai, me]); assert.equal(L.def, 0);
  ai.x = L.x + 600; tick(195, [ai, me]); assert.equal(L.def, 0);
  tick(10, [ai, me]); assert.ok(L.def > 0);
});

test('WorldScene 把「玩家正在和哪些城的守军交战」传给 cityTick（playerFightingGarrison），标签用 stronger_hint', () => {
  const src = readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8');
  assert.match(src, /cityTick\(cs, parties, \{[^}]*playerFightingGarrison \}\)/);
  assert.match(src, /strongerHint: balance\.v06\.city\.garrison\.stronger_hint/);
});
