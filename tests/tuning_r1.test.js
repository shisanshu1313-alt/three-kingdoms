import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balance } from '../src/data/index.js';
import combatJson from '../src/data/combat_v05.json' with { type: 'json' };
import { createCities, cityTick, siegeDps, siegeDpsCapped, garrisonBasePower, defMax, PLAYER } from '../src/systems/city.js';
import { pickStaleTeam } from '../src/systems/teams.js';
import AISystem from '../src/systems/ai.js';
import { attitude } from '../src/systems/aiBrain.js';
import { buildV06 } from '../scripts/sync-v06.mjs';

// 策划 tuning_r1（2026-10-23）：T1–T3 apply_now 生效；T4–T6 needs_user 只准备开关、默认关。数值都来自 v06.tuning（sync-v06 从 balance_v0.6.json 生成）
const TU = balance.v06.tuning;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/balance_v0.6.json', import.meta.url)));
const withTuning = over => ({ ...balance, v06: { ...balance.v06, tuning: { ...TU, ...over } } });
const ctx = (over = {}) => ({ tS: 0, dt: 0.1, chapter: 0, balance, move: combatJson.move, homeCity: null, ...over });

test('配置：tuning 来自 tuning_r1.proposals —— T1 15 s、T2 0.6 / 400 px 黄巾、T3 黄巾 0.4；T4–T6 needs_user → 关', () => {
  assert.equal(TU.siege_min_s, 15);
  assert.deepEqual(TU.stale_refresh, { enabled: true, faction: '黄巾', stale_ratio: 0.6, min_dist_px: 400 });
  assert.deepEqual(TU.flee_ratio_by_faction, { 黄巾: 0.4 });
  assert.equal(TU.garrison_power_floor.enabled, false); assert.equal(TU.garrison_power_floor.value, 70);
  assert.equal(TU.field_regroup.enabled, false); assert.equal(TU.escape_points.enabled, false);
});

test('配置：proposal 改成 needs_user → 关掉；正式字段 city_v06.siege.siege_min_s 优先；没有 tuning_r1 → 全关（0 / 空）', () => {
  const d = structuredClone(fixture);
  for (const p of d.tuning_r1.proposals) if (['T1', 'T2', 'T3'].includes(p.id)) p.tag = 'needs_user';
  let t = buildV06(d).tuning;
  assert.equal(t.siege_min_s, 0); assert.equal(t.stale_refresh.enabled, false); assert.deepEqual(t.flee_ratio_by_faction, {});
  d.city_v06.siege = { ...(d.city_v06.siege ?? {}), siege_min_s: 20 };
  assert.equal(buildV06(d).tuning.siege_min_s, 20);
  const e = structuredClone(fixture); delete e.tuning_r1;
  t = buildV06(e).tuning;
  assert.equal(t.siege_min_s, 0); assert.equal(t.stale_refresh.enabled, false);
  const f = structuredClone(fixture); f.tuning_r1.proposals.find(p => p.id === 'T4').tag = 'apply_now';
  assert.equal(buildV06(f).tuning.garrison_power_floor.enabled, true);
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
  assert.equal(attitude(50, 100, P.aggressive), 'flee');
  assert.equal(new AISystem(withTuning({ flee_ratio_by_faction: {} })).personalityOf({ faction: 'bandit' }).flee_ratio, 0.6);
});

test('T4（needs_user，默认关）：守军战力下限只在开关打开时生效', () => {
  const k = balance.v06.city.garrison.power_vs_player;
  assert.equal(garrisonBasePower(64, balance), 64, '默认关：仍是 0.5 × 玩家');
  const on = withTuning({ garrison_power_floor: { enabled: true, value: 70 } });
  assert.ok(Math.abs(garrisonBasePower(64, on) * k - 70) < 1e-9);
  assert.equal(garrisonBasePower(400, on), 400);
});
