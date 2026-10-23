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
  assert.match(design.city_v06.siege.chapter_change, /当前值不变/);
  assert.match(design.city_v06.siege.regen_rule, /倒计时暂停（不重置）/);
  const v = buildV06(design);
  assert.equal(v.city.garrison.stronger_hint, 'gt'); assert.equal(v.city.chapter_change, 'keep'); assert.equal(v.city.regen_rule, 'away');
  assert.equal(v.city.regen_hold, 'pause', '「倒计时暂停（不重置），再离开时接着计」');
  assert.match(design.city_v06.siege.chapter_change, /满的.*抬到新章上限/);
  assert.equal(v.city.break_window_s, 20);
  assert.deepEqual([C.garrison.stronger_hint, C.chapter_change, C.regen_rule, C.regen_hold], ['gt', 'keep', 'away', 'pause'], 'src/data/v06.json 已同步');
  // 没有这些字段（旧定稿）→ 旧行为
  const old = structuredClone(design);
  delete old.city_v06.siege.regen_rule; old.city_v06.siege.chapter_change = '换章时城防上限换成新章数值，当前城防按比例放大';
  const o = buildV06(old);
  assert.equal(o.city.chapter_change, 'scale'); assert.equal(o.city.regen_rule, 'since_zero'); assert.equal(o.city.regen_hold, null);
  const r = structuredClone(design); r.city_v06.siege.regen_rule = '城防归零后，玩家贴着城或正在和守军交战，回复倒计时就暂停；玩家离开满 20 秒才开始回复';
  assert.equal(buildV06(r).city.regen_hold, 'reset');
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

test('规则 2 换章：每秒城防伤害上限立即换成新章「城防上限 ÷ 15」；正在被攻（不满）的城当前值不变；满城防的城抬到新章上限', () => {
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
  assert.equal(cs.xuchang.def, 420, '没被打过的满城防城 → 抬到新章上限');
  // 已回满的城（被打过、又回满）同样算满
  cs.chengdu.def = 420; applyChapter(cs, 2, balance); assert.equal(cs.chengdu.def, 700); assert.equal(L.def < 420, true);
  // 差一点没回满 → 不变
  cs.jianye.def = 699.5; applyChapter(cs, 3, balance); assert.equal(cs.jianye.def, 699.5); assert.equal(cs.chengdu.def, 870);
});

test('规则 3 城防回复：城防 0 后玩家贴着城 / 正在和守军交战 → 倒计时暂停（不重置）；离开且不交战累计满 20 s 才开始回复，之后要重新破城', () => {
  const cs = createCities(balance), L = cs.luoyang;
  const pl = { id: 'player', isPlayer: true, faction: 'player', x: L.x, y: L.y + 50, r: 15, unit: 'inf', power: 2000, soldiers: 100 };
  let t = 0;
  const tick = (n, o = {}) => { for (let i = 0; i < n; i++) cityTick(cs, [pl], ctx({ tS: t = +(t + 0.1).toFixed(3), ...o })); };
  const away = () => { pl.x = L.x + 500; }, back = () => { pl.x = L.x; pl.y = L.y + 50; };
  tick(200); assert.equal(L.def, 0, '破城');
  tick(400); assert.equal(L.def, 0, '玩家一直贴着城 40 s：不回复');
  assert.equal(L.zeroAwayS, 0);
  away(); tick(100); assert.equal(L.def, 0); assert.ok(Math.abs(L.zeroAwayS - 10) < 1e-6, '离开 10 s');
  back(); tick(150); assert.equal(L.def, 0, '回到城边 15 s：不回复');
  assert.ok(Math.abs(L.zeroAwayS - 10) < 1e-6, '倒计时暂停，不重置（还是 10 s）');
  away(); tick(50, { playerFightingGarrison: ['luoyang'] }); assert.equal(L.def, 0, '离开城但在和守军交战：暂停');
  assert.ok(Math.abs(L.zeroAwayS - 10) < 1e-6);
  tick(99); assert.equal(L.def, 0, '再离开 9.9 s：累计 19.9 s，还是 0');
  tick(1); assert.ok(L.def > 0 && L.def < 230 * 0.03 * 0.2, `累计满 20 s（且 8 s 没挨打）→ 这一 tick 开始回复（${L.def}）`);
  assert.equal(L.zeroAwayS, 0, '回复后计时清零');
  tick(20); const d = L.def; assert.ok(d > 0);
  // 回复之后城防 > 0：要重新破城（玩家再贴上来 = 攻城，按上限扣）
  back(); tick(1); assert.ok(L.def < d && L.def >= 0);
  // 再次破城 → 离开计时从 0 开始
  tick(100); assert.equal(L.def, 0); assert.equal(L.zeroAwayS, 0);
});

test('规则 3：regen_hold = reset（只写「暂停」没写不重置）→ 回城边清零，离开要重新连续满 20 s', () => {
  const b = { ...balance, v06: { ...balance.v06, city: { ...C, regen_hold: 'reset' } } };
  const cs = createCities(b), L = cs.luoyang;
  const pl = { id: 'player', isPlayer: true, faction: 'player', x: L.x, y: L.y + 50, r: 15, unit: 'inf', power: 2000, soldiers: 100 };
  let t = 0;
  const tick = n => { for (let i = 0; i < n; i++) cityTick(cs, [pl], ctx({ tS: t = +(t + 0.1).toFixed(3), balance: b })); };
  tick(200); assert.equal(L.def, 0);
  pl.x = L.x + 500; tick(150); pl.x = L.x; tick(1); assert.equal(L.zeroAwayS, 0);
  pl.x = L.x + 500; tick(150); assert.equal(L.def, 0, '只连续离开 15 s');
  tick(60); assert.ok(L.def > 0);
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

test('third_party：AI 在打守军时玩家加入 → 守军不重算（战斗体兵数不变、engageSoldiers 不对守军调用），onEngage 也不重算队伍', async () => {
  const M = await import('../src/systems/melee.js');
  const { garrisonEngageSoldiers, garrisonRecalcOnEngage } = await import('../src/systems/city.js');
  const cfg = { ...M.makeCombatConfig(combatJson, balance), fixedRoll: 1 };
  const gen = id => [{ id, name: id, lead: 50, str: 40, int: 40, cha: 40, generic: true }];
  const s = M.createCombatState({ seed: 1 });
  const gTeam = { id: 'garrison_luoyang', faction: 'bandit', unit: 'inf', soldiers: 40, generals: gen('g'), items: [], cityHold: 'luoyang', garrisonFull: 40, garrisonKeep: 1 };
  M.addBody(s, M.makeBody({ ...gTeam, position: { x: 0, y: 0 } }, balance, cfg, { h: 0 }));
  M.addBody(s, M.makeBody({ id: 'wei1', faction: 'wei', unit: 'inf', soldiers: 40, generals: gen('w'), items: [], position: { x: 0, y: 0 } }, balance, cfg, { h: Math.PI }));
  M.addBody(s, M.makeBody({ id: 'player', faction: 'player', unit: 'inf', soldiers: 40, generals: gen('p'), items: [], position: { x: 0, y: 2000 } }, balance, cfg, { h: 0 }));
  const G = s.bodies.garrison_luoyang, W = s.bodies.wei1, P = s.bodies.player;
  W.x = G.x + M.radiusOf(M.soldiersOf(W), cfg) + M.radiusOf(M.soldiersOf(G), cfg) - 2; W.y = G.y;
  const calls = [];
  const env = { hostile: (a, b) => a.faction !== b.faction, engageSoldiers: (X, Y) => { calls.push([X.id, Y.id]); return X.id === 'garrison_luoyang' ? garrisonEngageSoldiers(gTeam, Y.id === 'player', 1000, balance) : null; } };
  let st = M.step(s, {}, 0.1, cfg, env);
  assert.ok(st.events.some(e => e.type === 'engage'), 'AI 和守军开战');
  assert.equal(st.bodies.garrison_luoyang.N0, 40, 'AI 打守军：不重算');
  const n0 = st.bodies.garrison_luoyang.N0start;
  // 玩家贴上来
  const g2 = st.bodies.garrison_luoyang, p2 = st.bodies.player;
  p2.x = g2.x - M.radiusOf(M.soldiersOf(p2), cfg) - M.radiusOf(M.soldiersOf(g2), cfg) + 2; p2.y = g2.y;
  const fighting = new Set(Object.values(st.bodies).filter(M.inCombat).map(b => b.id));
  calls.length = 0;
  st = M.step(st, {}, 0.1, cfg, env);
  const e = st.events.find(x => x.type === 'engage' && [x.a, x.b].includes('player'));
  assert.ok(e, '玩家加入');
  assert.equal(st.bodies.garrison_luoyang.N0start, n0, '守军战斗体不变');
  assert.ok(!calls.some(([x]) => x === 'garrison_luoyang'), 'engageSoldiers 不对已在交战的守军调用');
  const fresh = [e.a, e.b].filter(id => !fighting.has(id)); // = FieldBattle 写进 engage 事件的 e.fresh
  assert.deepEqual(fresh, ['player']);
  assert.equal(garrisonRecalcOnEngage(gTeam, true, fresh.includes('garrison_luoyang'), balance), false, 'onEngage：守军不重算');
  assert.equal(garrisonRecalcOnEngage(gTeam, true, true, balance), true, '玩家和不在交战的守军开战 → 重算');
  assert.equal(garrisonRecalcOnEngage(gTeam, false, true, balance), false, 'AI 和守军开战 → 不重算');
  assert.equal(garrisonRecalcOnEngage({ ...gTeam, cityHold: undefined }, true, true, balance), false);
});

test('third_party 接线：FieldBattle 给 engage 事件写 fresh；WorldScene.onEngage 只在守军 fresh 时重算', () => {
  const fb = readFileSync(new URL('../src/systems/fieldBattle.js', import.meta.url), 'utf8');
  assert.match(fb, /e\.fresh = \[e\.a, e\.b\]\.filter\(id => !fighting\.has\(id\)\)/);
  const ws = readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8');
  assert.match(ws, /onEngage: \(a, b, e\) =>/);
  assert.match(ws, /garrisonRecalcOnEngage\(g\?\.team, o\?\.isPlayer, e\?\.fresh\?\.includes\(g\?\.id\), balance\)/);
});

test('正式构建：vite.config 只在 build + production 去掉 console.log / debug / info，保留 warn / error；F1 调试视野只在 DEBUG_HOOKS 构建', () => {
  const vc = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(vc, /command === 'build' && mode === 'production' \? \{ pure: \['console\.log', 'console\.debug', 'console\.info'\] \}/);
  assert.doesNotMatch(vc, /drop:/);
  const ws = readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8');
  assert.match(ws, /if \(DEBUG_HOOKS\) this\.actions\.on\(ACTIONS\.DEBUG_VISION/);
  const ui = readFileSync(new URL('../src/scenes/UIScene.js', import.meta.url), 'utf8');
  assert.match(ui, /DEBUG_HOOKS \? ' · F1 调试（视野\/路径）/);
});
