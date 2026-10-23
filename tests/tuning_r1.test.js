import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balance } from '../src/data/index.js';
import combatJson from '../src/data/combat_v05.json' with { type: 'json' };
import { createCities, cityTick, siegeDps, siegeDpsCapped, garrisonBasePower, garrisonTargetPower, garrisonFullSoldiers, garrisonRecalc, garrisonEngageSoldiers, garrisonPreviewPower, cityLabel, defMax, PLAYER } from '../src/systems/city.js';
import { pickStaleTeam, buildRespawnTeam } from '../src/systems/teams.js';
import { computePower } from '../src/systems/combat.js';
import { mulberry32 } from '../src/systems/rng.js';
import * as M from '../src/systems/melee.js';
import AISystem from '../src/systems/ai.js';
import { attitude } from '../src/systems/aiBrain.js';
import { buildV06 } from '../scripts/sync-v06.mjs';

// 策划 tuning_r1（2026-10-23 已定）：T1–T4 生效（tag = decided）；T5 / T6 用户否决（rejected），不进配置。数值都来自 v06.tuning（sync-v06 从 balance_v0.6.json 生成）
const TU = balance.v06.tuning;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/balance_v0.6.json', import.meta.url)));
const withTuning = over => ({ ...balance, v06: { ...balance.v06, tuning: { ...TU, ...over } } });
const ctx = (over = {}) => ({ tS: 0, dt: 0.1, chapter: 0, balance, move: combatJson.move, homeCity: null, ...over });

test('配置：tuning 来自 tuning_r1.proposals（已定）—— T1 15 s、T2 0.6 / 400 px 黄巾、T3 黄巾 0.4、T4 守军下限 70；T5 / T6 不进配置', () => {
  assert.equal(TU.siege_min_s, 15);
  assert.deepEqual(TU.stale_refresh, { enabled: true, faction: '黄巾', stale_ratio: 0.6, min_dist_px: 400 });
  assert.deepEqual(TU.flee_ratio_by_faction, { 黄巾: 0.4 });
  assert.deepEqual(TU.garrison_power_floor, { enabled: true, value: 70, power_vs_player: 0.5, recalc: 'battle_start', label_applies_ratio: true });
  assert.equal(fixture.city_v06.garrison.power_floor, 70, '正式字段 city_v06.garrison.power_floor');
  assert.ok(fixture.city_v06.garrison.power_recalc?.when, '正式字段 city_v06.garrison.power_recalc → 开战时重算');
  assert.equal(TU.garrison_power_floor.power_vs_player, balance.v06.city.garrison.power_vs_player, '提案里的 0.5 = 守军配置的 power_vs_player');
  assert.deepEqual(Object.keys(TU).sort(), ['chapter_spawn_power', 'first_battle_at_s', 'flee_ratio_by_faction', 'gacha_pool_weights', 'garrison_power_floor', 'siege_min_s', 'stale_refresh'], 'tuning_r1 四项 + tuning_r2 N2/N3（chapter_spawn_power）+ U1（first_battle_at_s）+ U3（gacha_pool_weights）');
  assert.deepEqual(fixture.tuning_r1.proposals.filter(p => p.tag === 'rejected').map(p => p.id), ['T5', 'T6']);
});

test('配置：tag 不是 decided / apply_now → 关掉；正式字段优先；没有 tuning_r1 → 全关', () => {
  const d = structuredClone(fixture);
  for (const p of d.tuning_r1.proposals) if (['T1', 'T2', 'T3', 'T4'].includes(p.id)) p.tag = 'needs_user';
  delete d.city_v06.garrison.power_floor; delete d.city_v06.garrison.power_recalc; // 只剩提案（tag 不是已定）→ 关
  let t = buildV06(d).tuning;
  assert.equal(t.siege_min_s, 0); assert.equal(t.stale_refresh.enabled, false); assert.deepEqual(t.flee_ratio_by_faction, {}); assert.equal(t.garrison_power_floor.enabled, false);
  d.city_v06.siege = { ...(d.city_v06.siege ?? {}), siege_min_s: 20 };
  d.city_v06.garrison = { power_floor: 80 };
  t = buildV06(d).tuning;
  assert.equal(t.siege_min_s, 20); assert.deepEqual(t.garrison_power_floor, { enabled: true, value: 80, power_vs_player: 0.5, recalc: 'spawn', label_applies_ratio: true }, '有 power_floor 没 power_recalc → 开局算一次');
  const e = structuredClone(fixture); delete e.tuning_r1;
  t = buildV06(e).tuning;
  assert.equal(t.siege_min_s, 0); assert.equal(t.stale_refresh.enabled, false);
  assert.deepEqual(t.garrison_power_floor, TU.garrison_power_floor, '守军下限是正式字段 city_v06.garrison，不依赖 tuning_r1');
  delete e.city_v06.garrison.power_floor; delete e.city_v06.garrison.power_recalc;
  assert.equal(buildV06(e).tuning.garrison_power_floor.enabled, false);
});

test('T1：每秒城防伤害 ≤ 该章城防上限 / siege_min_s；高战力玩家满城防打到 0 ≥ 15 s（第 1–4 章）', () => {
  for (let ch = 0; ch < 4; ch++) {
    const cs = createCities(balance, { chapter: ch, garrison: false }), L = cs.luoyang, max = defMax(balance, ch);
    L.def = max;
    const pl = { id: 'player', isPlayer: true, faction: PLAYER, x: L.x + 40, y: L.y, r: 18, unit: 'inf', power: 10000, soldiers: 100 };
    assert.ok(siegeDps(pl.power, pl.unit, balance) > max / 15 * 5, '不限的话几秒就破');
    let t = 0, breached = null;
    while (L.def > 0 && t < 60) { t = +(t + 0.1).toFixed(3); const r = cityTick(cs, [pl], ctx({ tS: t, chapter: ch })); if (r.events.some(e => e.type === 'breached')) breached = t; }
    assert.ok(breached >= 15 - 1e-6 && breached <= 15.2, `第 ${ch + 1} 章 ${breached}`);
  }
  // 战力低于上限时不受影响（原攻城表不变）
  assert.equal(siegeDpsCapped(10, 230, balance), 10);
  assert.equal(siegeDpsCapped(100, 230, balance), 230 / 15);
  assert.equal(siegeDpsCapped(100, 230, withTuning({ siege_min_s: 0 })), 100);
});

test('T1：多队一起攻城也共用同一个上限（城防伤害总和）', () => {
  const cs = createCities(balance, { garrison: false }), L = cs.luoyang, max = L.def;
  const mk = i => ({ id: `p${i}`, isPlayer: i === 0, faction: PLAYER, x: L.x + 30, y: L.y + i, r: 18, unit: 'inf', power: 1000, soldiers: 100 });
  cityTick(cs, [mk(0), mk(1)], ctx({ tS: 0.1 }));
  assert.ok(Math.abs((max - L.def) - max / 15 * 0.1) < 1e-9);
});

const pl = { id: 'player', isPlayer: true, faction: 'player', x: 0, y: 0, power: 100, team: {} };
const B = (id, over = {}) => ({ id, faction: 'bandit', power: 40, x: 1000, y: 0, inBattle: false, team: {}, ...over });

test('T2：满员撤下过弱普通黄巾队 —— 战力 < 0.6 × 玩家、不在交战、> 400 px；最弱的（同战力按 id）', () => {
  assert.equal(pickStaleTeam([B('a', { power: 50 }), B('b', { power: 30 }), B('c', { power: 30 })], pl, balance).id, 'b');
  assert.equal(pickStaleTeam([B('a', { power: 60 })], pl, balance), null, '= 0.6 倍不算（严格小于）');
  assert.equal(pickStaleTeam([B('a', { power: 59.9 })], pl, balance).id, 'a');
  assert.equal(pickStaleTeam([B('a', { inBattle: true })], pl, balance), null, '交战中');
  assert.equal(pickStaleTeam([B('a', { x: 400 })], pl, balance), null, '400 px 内');
  assert.equal(pickStaleTeam([B('a', { x: 300, y: 300 })], pl, balance).id, 'a', '424 px');
});

test('T2：不撤来袭 / 守军 / 攻城队 / 名将军 / 校尉军 / 其他势力；关掉后不撤', () => {
  const ex = [B('r', { team: { raid: true } }), B('g', { team: { cityHold: 'luoyang' } }), B('s', { team: { siegeTarget: 'luoyang' } }),
    B('qun_lvbu'), B('refill_3'), B('w', { faction: 'wei' })];
  assert.equal(pickStaleTeam(ex, pl, balance, { namedIds: new Set(['qun_lvbu']) }), null);
  assert.equal(pickStaleTeam([B('a')], pl, withTuning({ stale_refresh: { ...TU.stale_refresh, enabled: false } })), null);
  assert.equal(pickStaleTeam([B('a')], pl, withTuning({ stale_refresh: { ...TU.stale_refresh, faction: 'bandit' } })).id, 'a', '按 id 也认');
});

test('T3：黄巾 flee_ratio = 0.4（其余性格值不变）；魏蜀吴群雄仍按性格（0.8 / 1.0 / 0.6）', () => {
  const ai = new AISystem(balance);
  const P = balance.ai.personality;
  const b = ai.personalityOf({ faction: 'bandit' });
  assert.equal(b.flee_ratio, 0.4); assert.equal(b.key, 'aggressive'); assert.equal(b.chase_ratio, P.aggressive.chase_ratio);
  for (const f of balance.ai.factions.filter(x => x.id !== 'bandit')) assert.equal(ai.personalityOf({ faction: f.id }).flee_ratio, P[f.personality].flee_ratio, f.id);
  assert.equal(P.aggressive.flee_ratio, 0.6, '配置里的性格值没改');
  // 决策：比例 0.5 → 黄巾不再逃（0.6 时会逃），0.35 仍逃
  assert.notEqual(attitude(50, 100, b), 'flee');
  assert.equal(attitude(35, 100, b), 'flee');
  assert.equal(attitude(40, 100, b), 'flee', '边界：= 0.4 也逃（≤，策划确认）');
  assert.equal(attitude(28, 70, b), 'flee', '28/70 = 0.4');
  assert.notEqual(attitude(40.01, 100, b), 'flee', '略高于 0.4 不逃');
  assert.equal(attitude(50, 100, P.aggressive), 'flee');
  assert.equal(new AISystem(withTuning({ flee_ratio_by_faction: {} })).personalityOf({ faction: 'bandit' }).flee_ratio, 0.6);
});

test('T3 范围（策划 tuning_r1.T3.scope）：0.4 只管 AI 扫视野的逃跑决策；交战中途撤退不变（士气 < 30 溃败、性格撤退阈值）', () => {
  assert.match(fixture.tuning_r1.proposals.find(p => p.id === 'T3').scope, /交战中途撤退不受影响/);
  // 交战中 AI（combatAI.combatIntent）只拿性格 key（fieldBattle 传 p.ai.personality.key），key 不因 T3 改变
  const on = new AISystem(balance).personalityOf({ faction: 'bandit' }), off = new AISystem(withTuning({ flee_ratio_by_faction: {} })).personalityOf({ faction: 'bandit' });
  assert.equal(on.key, off.key);
  const { flee_ratio: _a, ...restOn } = on, { flee_ratio: _b, ...restOff } = off;
  assert.deepEqual(restOn, restOff, '除 flee_ratio 外性格参数相同');
  for (const f of ['combatAI.js', 'melee.js', 'fieldBattle.js']) assert.doesNotMatch(readFileSync(new URL(`../src/systems/${f}`, import.meta.url), 'utf8'), /flee_ratio|tuning/, `${f} 不读 flee_ratio / tuning`);
  assert.match(readFileSync(new URL('../src/systems/fieldBattle.js', import.meta.url), 'utf8'), /combatIntent\(b, this\.state, mem, this\.cfg, p\.ai\?\.personality\?\.key/);
  assert.equal(combatJson.move.morale_rout, 30, '溃败线仍是士气 30');
});

test('T4：洛阳守军战力 = max(70, 0.5 × 玩家战力)（garrisonBasePower 返回再乘 power_vs_player 前的『玩家战力』）', () => {
  const k = balance.v06.city.garrison.power_vs_player, g = pp => garrisonBasePower(pp, balance) * k;
  assert.ok(Math.abs(g(64) - 70) < 1e-9, '开局约 64 → 70');
  assert.ok(Math.abs(g(140) - 70) < 1e-9);
  assert.equal(g(400), 200);
  assert.equal(garrisonBasePower(64, withTuning({ garrison_power_floor: { enabled: false, value: 70 } })), 64, '关掉 = 原 0.5 倍');
});

const K = balance.v06.city.garrison.power_vs_player;
const mkGarrison = (pp, seed = 1) => garrisonRecalc(buildRespawnTeam({ id: 'garrison_luoyang', position: { x: 0, y: 0 }, playerPower: garrisonBasePower(pp, balance), powerRange: [K, K], balance, rng: mulberry32(seed) }), pp, balance);
const mkG = (pp, seed) => Object.assign(mkGarrison(pp, seed), { cityHold: 'luoyang' });

test('T4 出生：守军兵数向上取整，战力 ≥ max(70, 0.5 × 玩家)，最多比四舍五入多 1 个兵（smoke 出现过 69）', () => {
  let raised = 0;
  for (let seed = 1; seed <= 200; seed++) for (const pp of [40, 64, 113.52, 300]) {
    const raw = buildRespawnTeam({ id: 'garrison_luoyang', position: { x: 0, y: 0 }, playerPower: garrisonBasePower(pp, balance), powerRange: [K, K], balance, rng: mulberry32(seed) });
    const before = raw.soldiers, t = garrisonRecalc(raw, pp, balance);
    assert.ok(computePower(t, balance) >= Math.max(70, K * pp) - 1e-9, `seed ${seed} pp ${pp}`);
    assert.ok(Math.abs(t.soldiers - before) <= 1); assert.equal(t.garrisonKeep, 1); assert.equal(t.garrisonFull, t.soldiers);
    if (t.soldiers > before) raised++;
  }
  assert.ok(raised > 0, '确实有取整偏低的情况');
  assert.equal(garrisonTargetPower(64, withTuning({ garrison_power_floor: { enabled: false, value: 70 } })), 32, '关掉 T4 = 0.5 × 玩家');
});

test('T4 power_recalc：新一次攻城（守军不在交战）按当时玩家战力重算 max(70, 0.5 × 玩家)', () => {
  const t = mkGarrison(64);
  assert.ok(computePower(t, balance) >= 70 && computePower(t, balance) < 72);
  garrisonRecalc(t, 300, balance); // 玩家涨到 300 后再来攻
  const p300 = computePower(t, balance);
  assert.ok(p300 >= 150 && p300 < 150 + 3, `≈150（${p300}）`);
  garrisonRecalc(t, 100, balance); // 玩家掉回 100 → 守军回到 70 下限（没损失 → 满编）
  assert.ok(computePower(t, balance) >= 70 && computePower(t, balance) < 72);
  assert.equal(t.soldiers, t.garrisonFull);
});

test('T4 power_recalc：之前攻城打掉的损失按比例保留，重算不补满；反复重算不漂移', () => {
  const t = mkGarrison(64), full0 = t.garrisonFull;
  t.soldiers = Math.round(full0 / 2); // 第一次攻城后守军剩一半（combat-end 写回 team.soldiers）
  const keep = t.soldiers / full0;
  garrisonRecalc(t, 300, balance);
  assert.ok(Math.abs(t.garrisonKeep - keep) < 1e-9);
  assert.equal(t.soldiers, Math.max(1, Math.floor(t.garrisonFull * keep + 0.5)), '新满编 × 剩余比例');
  assert.ok(t.soldiers < t.garrisonFull, '没补满');
  const n = t.soldiers;
  for (let i = 0; i < 50; i++) garrisonRecalc(t, 300, balance);
  assert.equal(t.soldiers, n, '同战力反复重算不变');
  for (const pp of [100, 400, 64, 300]) garrisonRecalc(t, pp, balance);
  assert.equal(t.soldiers, n, '玩家战力来回变，比例不漂移');
  assert.ok(Math.abs(t.garrisonKeep - keep) < 1e-9);
});

test('T4 power_recalc：只在玩家开战那一刻重算（melee env.engageSoldiers）；守军打 AI / 没开 recalc → 不改；破城防阶段涨的战力算进开战时', () => {
  const t = mkG(64), n = t.soldiers;
  assert.equal(garrisonEngageSoldiers(t, false, 400, balance), null, '对手不是玩家');
  assert.equal(garrisonEngageSoldiers({ ...t, cityHold: undefined }, true, 400, balance), null, '不是守军');
  assert.equal(garrisonEngageSoldiers(t, true, 400, withTuning({ garrison_power_floor: { ...TU.garrison_power_floor, recalc: 'spawn' } })), null, 'recalc = spawn：开局定死');
  const e = garrisonEngageSoldiers(t, true, 400, balance); // 破城防时抽卡涨到 400，开战这一刻按 400 算
  assert.equal(t.soldiers, n, '回调不改原队');
  assert.equal(e, garrisonRecalc({ ...t }, 400, balance).soldiers);
  assert.ok(computePower({ ...t, soldiers: e }, balance) >= 200);
});

test('T4 power_recalc：开战瞬间 melee.step 用重算后的兵数开新的一场，交战中不变（玩家战力再涨也不变）', () => {
  const cfg = { ...M.makeCombatConfig(combatJson, balance), fixedRoll: 1 }, t = mkG(64);
  const s = M.createCombatState({ seed: 1 });
  const hero = { id: 'player', faction: 'player', unit: 'inf', soldiers: 60, generals: [{ id: 'h', name: 'h', lead: 50, str: 40, int: 40, cha: 40, generic: true }], items: [], position: { x: 0, y: 0 } };
  M.addBody(s, M.makeBody(hero, balance, cfg, { h: 0 }));
  M.addBody(s, M.makeBody({ ...t, position: { x: 0, y: 0 } }, balance, cfg, { h: Math.PI }));
  const A = s.bodies.player, G = s.bodies.garrison_luoyang;
  G.x = A.x + M.radiusOf(M.soldiersOf(A), cfg) + M.radiusOf(M.soldiersOf(G), cfg) - 2;
  let pp = 400;
  const env = { engageSoldiers: (X, Y) => X.id === 'garrison_luoyang' ? garrisonEngageSoldiers(t, Y.id === 'player', pp, balance) : null };
  let st = s, engagedN = null;
  for (let i = 0; i < 40; i++) {
    st = M.step(st, {}, 0.1, cfg, env);
    if (st.events.some(e => e.type === 'engage')) engagedN = st.bodies.garrison_luoyang.N0;
    if (engagedN != null) { pp = 1000; assert.equal(st.bodies.garrison_luoyang.N0start, engagedN, '交战中不变'); }
  }
  assert.equal(engagedN, garrisonRecalc({ ...t }, 400, balance).soldiers);
});

test('T4 标签值：不在交战时 = 按当前玩家战力重算（含保留损失），不改原队', () => {
  const t = mkGarrison(64), n = t.soldiers;
  assert.ok(garrisonPreviewPower(t, 64, balance) >= 70);
  assert.ok(garrisonPreviewPower(t, 400, balance) >= 200);
  assert.equal(t.soldiers, n, '预览不改原队');
  t.soldiers = Math.round(t.garrisonFull / 2);
  const half = garrisonPreviewPower(t, 400, balance);
  assert.ok(half > 100 && half < 120, `兵力一半（武将战力项不减），约 111（${half}）`);
});

test('T4 remain_frac 累计（相对最初满编，不是相对上一场）：1 → 0.5 → 0.25', () => {
  const t = mkG(64);
  t.soldiers = t.garrisonFull / 2; garrisonRecalc(t, 300, balance); // 第一场打掉一半
  assert.ok(Math.abs(t.garrisonKeep - 0.5) < 0.02);
  t.soldiers = Math.round(t.soldiers / 2); garrisonRecalc(t, 300, balance); // 第二场又打掉一半
  assert.ok(Math.abs(t.garrisonKeep - 0.25) < 0.02, `${t.garrisonKeep}`);
  assert.equal(t.soldiers, Math.max(1, Math.floor(t.garrisonFull * t.garrisonKeep + 0.5)));
});

test('T4 标签：不在交战 = max(70, 0.5×玩家) × remain_frac；label_applies_ratio = false 不乘；「强于你」按标签值判断', () => {
  const t = mkG(64); t.soldiers = Math.round(t.garrisonFull / 2);
  const withRatio = garrisonPreviewPower(t, 400, balance);
  const noRatio = garrisonPreviewPower(t, 400, withTuning({ garrison_power_floor: { ...TU.garrison_power_floor, label_applies_ratio: false } }));
  assert.ok(noRatio >= 200 && withRatio < noRatio * 0.6, `${withRatio} / ${noRatio}`);
  const cs = createCities(balance), L = cs.luoyang, max = defMax(balance, 0);
  assert.equal(cityLabel(L, { max, garrisonPower: withRatio, playerPower: 150 }).color, '#ffffff', '玩家 150 > 标签值 → 不提示（满编会是 200）');
  assert.equal(cityLabel(L, { max, garrisonPower: noRatio, playerPower: 150 }).color, '#ff7777');
});

test('T4 标签：有守军的城显示守军战力；玩家战力低于守军 → 红色 +「强于你」；没守军 / 别的城不显示', () => {
  const cs = createCities(balance), L = cs.luoyang, max = defMax(balance, 0);
  let r = cityLabel(L, { max, garrisonPower: 70.4, playerPower: 64 });
  assert.match(r.text, /黄巾守军\s+城防 230\/230\s+守军战力 70（强于你）/);
  assert.equal(r.color, '#ff7777');
  r = cityLabel(L, { max, garrisonPower: 70, playerPower: 90 });
  assert.match(r.text, /守军战力 70$/); assert.doesNotMatch(r.text, /强于你/); assert.equal(r.color, '#ffffff');
  r = cityLabel(L, { max, garrisonPower: 70, playerPower: 70 });
  assert.doesNotMatch(r.text, /强于你/, '相等不提示');
  r = cityLabel({ ...L, garrison: null }, { max, garrisonPower: null, playerPower: 10 });
  assert.equal(r.text, '无主城  城防 230/230');
  r = cityLabel(cs.xuchang, { max, factionName: '魏', garrisonPower: null, playerPower: 10 });
  assert.equal(r.text, '魏大本营  城防 230/230');
  r = cityLabel({ ...L, owner: PLAYER, garrison: null }, { max, storeText: '  存放 0/6', playerPower: 10 });
  assert.equal(r.text, '我的主城  城防 230/230  存放 0/6'); assert.equal(r.color, '#aaffaa');
});
