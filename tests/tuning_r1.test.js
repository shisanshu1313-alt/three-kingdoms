import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balance } from '../src/data/index.js';
import combatJson from '../src/data/combat_v05.json' with { type: 'json' };
import { createCities, cityTick, siegeDps, siegeDpsCapped, garrisonBasePower, garrisonEnsureFloor, cityLabel, defMax, PLAYER } from '../src/systems/city.js';
import { pickStaleTeam, buildRespawnTeam } from '../src/systems/teams.js';
import { computePower } from '../src/systems/combat.js';
import { mulberry32 } from '../src/systems/rng.js';
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
  assert.deepEqual(TU.garrison_power_floor, { enabled: true, value: 70, power_vs_player: 0.5 });
  assert.equal(TU.garrison_power_floor.power_vs_player, balance.v06.city.garrison.power_vs_player, '提案里的 0.5 = 守军配置的 power_vs_player');
  assert.deepEqual(Object.keys(TU).sort(), ['flee_ratio_by_faction', 'garrison_power_floor', 'siege_min_s', 'stale_refresh']);
  assert.deepEqual(fixture.tuning_r1.proposals.filter(p => p.tag === 'rejected').map(p => p.id), ['T5', 'T6']);
});

test('配置：tag 不是 decided / apply_now → 关掉；正式字段优先；没有 tuning_r1 → 全关', () => {
  const d = structuredClone(fixture);
  for (const p of d.tuning_r1.proposals) if (['T1', 'T2', 'T3', 'T4'].includes(p.id)) p.tag = 'needs_user';
  let t = buildV06(d).tuning;
  assert.equal(t.siege_min_s, 0); assert.equal(t.stale_refresh.enabled, false); assert.deepEqual(t.flee_ratio_by_faction, {}); assert.equal(t.garrison_power_floor.enabled, false);
  d.city_v06.siege = { ...(d.city_v06.siege ?? {}), siege_min_s: 20 };
  d.city_v06.garrison = { power_floor: 80 };
  t = buildV06(d).tuning;
  assert.equal(t.siege_min_s, 20); assert.deepEqual(t.garrison_power_floor, { enabled: true, value: 80 });
  const e = structuredClone(fixture); delete e.tuning_r1;
  t = buildV06(e).tuning;
  assert.equal(t.siege_min_s, 0); assert.equal(t.stale_refresh.enabled, false); assert.equal(t.garrison_power_floor.enabled, false);
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

test('T4：洛阳守军战力 = max(70, 0.5 × 玩家战力)（garrisonBasePower 返回再乘 power_vs_player 前的『玩家战力』）', () => {
  const k = balance.v06.city.garrison.power_vs_player, g = pp => garrisonBasePower(pp, balance) * k;
  assert.ok(Math.abs(g(64) - 70) < 1e-9, '开局约 64 → 70');
  assert.ok(Math.abs(g(140) - 70) < 1e-9);
  assert.equal(g(400), 200);
  assert.equal(garrisonBasePower(64, withTuning({ garrison_power_floor: { enabled: false, value: 70 } })), 64, '关掉 = 原 0.5 倍');
});

test('T4：守军按目标战力建队后兵数取整可能偏低 → garrisonEnsureFloor 补兵到 ≥ max(70, 0.5 × 玩家)，只多 1 个兵以内', () => {
  const k = balance.v06.city.garrison.power_vs_player;
  let raised = 0;
  for (let seed = 1; seed <= 200; seed++) for (const pp of [40, 64, 113.52, 300]) {
    const team = buildRespawnTeam({ id: 'garrison_luoyang', position: { x: 0, y: 0 }, playerPower: garrisonBasePower(pp, balance), powerRange: [k, k], balance, rng: mulberry32(seed) });
    const before = team.soldiers, want = Math.max(70, k * pp);
    garrisonEnsureFloor(team, pp, balance);
    assert.ok(computePower(team, balance) >= want - 1e-9, `seed ${seed} pp ${pp}`);
    assert.ok(team.soldiers - before <= 1);
    if (team.soldiers > before) raised++;
  }
  assert.ok(raised > 0, '确实有取整偏低的情况（如 smoke 里出现过 69）');
  const t = buildRespawnTeam({ id: 'g', position: { x: 0, y: 0 }, playerPower: 64, powerRange: [k, k], balance, rng: mulberry32(1) }), n = t.soldiers;
  garrisonEnsureFloor(t, 64, withTuning({ garrison_power_floor: { enabled: false, value: 70 } }));
  assert.equal(t.soldiers, n, '关掉 T4 不补');
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
