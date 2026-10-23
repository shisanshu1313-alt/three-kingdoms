import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance } from '../src/data/index.js';
import combatJson from '../src/data/combat_v05.json' with { type: 'json' };
import { createGameState } from '../src/systems/gameState.js';
import { mulberry32 } from '../src/systems/rng.js';
import { createCities, cityTick, arrowRate, siegeDps, protectingCity, noEngage, applyChapter, capture, decline, loseCity, serviceCity, freeConqueredCapitals,
  siegePlayerDue, siegeEmptyDue, pickSiegeTeam, pickNearbyTeam, defMax, PLAYER } from '../src/systems/city.js';

const move = combatJson.move;
const ctx = (over = {}) => ({ tS: 0, dt: 0.1, chapter: 0, balance, move, homeCity: null, ...over });

test('开局：5 座城；洛阳无主有黄巾守军；4 座大本营归势力；城防 = 第 1 章 230', () => {
  const cs = createCities(balance);
  assert.equal(cs.luoyang.owner, null); assert.equal(cs.luoyang.garrison, 'bandit');
  assert.deepEqual(['xuchang', 'chengdu', 'jianye', 'changan'].map(id => cs[id].owner), ['wei', 'shu', 'wu', 'qun']);
  assert.ok(Object.values(cs).every(c => c.def === 230));
  assert.equal(createCities(balance, { garrison: false }).luoyang.garrison, null);
});

test('攻城计算表（calc_table_ratio_1）：同参考战力 4 兵种 × 4 章的破城时间与损兵', () => {
  const C = balance.v06.city;
  const table = [[1, 'inf', 16.7, 4.9], [1, 'spr', 20.0, 9.8], [1, 'arc', 25.0, 12.2], [1, 'cav', 28.6, 14.0], [2, 'inf', 21.1, 6.2], [2, 'cav', 36.1, 17.7],
    [3, 'spr', 29.9, 14.6], [4, 'inf', 29.1, 8.6], [4, 'arc', 43.7, 21.4], [4, 'cav', 49.9, 24.4]];
  for (const [ch, unit, sec, loss] of table) {
    const P = C.arrow_ref_power[ch - 1], t = C.def_by_chapter[ch - 1] / siegeDps(P, unit, balance);
    assert.ok(Math.abs(t - sec) < 0.06, `${ch} ${unit} ${t}`);
    const pct = arrowRate({ power: P, unit }, ch - 1, balance, move) * t * 100;
    assert.ok(Math.abs(pct - loss) < 0.06, `${ch} ${unit} loss ${pct}`);
  }
});

test('cityTick：玩家攻洛阳 → 城防降、挨箭、城破；20 s 城破窗口内不回；之后 8 s 没被攻击开始每秒回 3%', () => {
  const cs = createCities(balance);
  const L = cs.luoyang;
  const pl = { id: 'player', isPlayer: true, faction: PLAYER, x: L.x + 50, y: L.y, r: 18, unit: 'inf', power: 115, soldiers: 100 };
  let t = 0, lost = 0, breached = null;
  while (L.def > 0 && t < 30) { t = +(t + 0.1).toFixed(3); const r = cityTick(cs, [pl], ctx({ tS: t })); lost += r.losses.player ?? 0; if (r.events.some(e => e.type === 'breached')) breached = t; }
  assert.ok(Math.abs(breached - 16.7) < 0.15, String(breached)); assert.ok(Math.abs(lost - 4.9) < 0.15, String(lost));
  // 撤走：城破窗口 20 s 内保持 0
  pl.x = L.x + 500;
  for (let i = 0; i < 195; i++) { t = +(t + 0.1).toFixed(3); cityTick(cs, [pl], ctx({ tS: t })); }
  assert.equal(L.def, 0);
  for (let i = 0; i < 20; i++) { t = +(t + 0.1).toFixed(3); cityTick(cs, [pl], ctx({ tS: t })); }
  assert.ok(L.def > 0 && L.def <= 230 * 0.03 * 2.1, String(L.def));
});

test('路过的 AI 不攻城；被派来攻城的 AI 才扣城防；城防 > 0 时城上弓箭打所有接触的敌队', () => {
  const cs = createCities(balance), X = cs.xuchang;
  const pass = { id: 'b1', faction: 'bandit', x: X.x, y: X.y + 40, r: 15, unit: 'cav', power: 100, soldiers: 50 };
  let r = cityTick(cs, [pass], ctx({ tS: 1 }));
  assert.equal(X.def, 230); assert.ok(r.losses.b1 > 0);
  r = cityTick(cs, [{ ...pass, siegeTarget: 'xuchang' }], ctx({ tS: 1.1 }));
  assert.ok(X.def < 230);
  // 自己势力的队伍不挨箭
  r = cityTick(cs, [{ ...pass, id: 'w', faction: 'wei' }], ctx({ tS: 1.2 }));
  assert.equal(r.losses.w, undefined);
});

test('保护：城防 > 0 时城里（≤60 px）自己一方的队伍不能被攻击 / 攻击；城防 0 或出城失去保护', () => {
  const cs = createCities(balance), X = cs.xuchang;
  const wei = { faction: 'wei', x: X.x + 30, y: X.y }, pl = { faction: PLAYER, x: X.x + 80, y: X.y };
  assert.equal(protectingCity(wei, cs, balance), X);
  assert.equal(noEngage(wei, pl, cs, balance), true);
  assert.equal(noEngage({ ...wei, x: X.x + 70 }, pl, cs, balance), false);
  X.def = 0; assert.equal(noEngage(wei, pl, cs, balance), false);
  // 洛阳守军（bandit）受保护，路过的玩家不受（不是自己的城）
  assert.equal(protectingCity({ faction: 'bandit', x: cs.luoyang.x, y: cs.luoyang.y }, cs, balance), cs.luoyang);
  assert.equal(protectingCity({ faction: PLAYER, x: cs.luoyang.x, y: cs.luoyang.y }, cs, balance), null);
});

test('占城：城防 0 + 守军已灭 + 城心 60 px 停 5 s → capture_ready；有主城时拒绝迁都要离开再回来；迁都旧城变无主、存放跟着走', () => {
  const s = createGameState(balance); s.cities = createCities(balance);
  const L = s.cities.luoyang; L.def = 0; L.zeroAtS = 0;
  const pl = { id: 'player', isPlayer: true, faction: PLAYER, x: L.x + 10, y: L.y, r: 18, unit: 'inf', power: 100, soldiers: 100 };
  let t = 0, ev = [];
  const run = n => { for (let i = 0; i < n; i++) { t = +(t + 0.1).toFixed(3); ev = ev.concat(cityTick(s.cities, [pl], ctx({ tS: t, homeCity: s.homeCity })).events); } };
  run(60); assert.equal(ev.filter(e => e.type === 'capture_ready').length, 0, '守军还在');
  L.garrison = null; run(49); assert.equal(ev.filter(e => e.type === 'capture_ready').length, 0);
  run(2); assert.equal(ev.filter(e => e.type === 'capture_ready').length, 1);
  capture(s, 'luoyang'); assert.equal(s.homeCity, 'luoyang'); assert.equal(L.owner, PLAYER);
  // 大本营：势力被讨伐前不能占
  const X = s.cities.xuchang; X.def = 0; pl.x = X.x; pl.y = X.y; ev = []; run(60);
  assert.equal(ev.filter(e => e.type === 'capture_ready').length, 0);
  assert.deepEqual(freeConqueredCapitals(s.cities, new Set(['wei'])).map(c => c.id), ['xuchang']);
  run(51); assert.equal(ev.filter(e => e.type === 'capture_ready').length, 1);
  decline(s, 'xuchang'); ev = []; run(80); assert.equal(ev.length, 0, '拒绝后不离开不再弹');
  pl.x += 200; run(1); pl.x -= 200; run(51); assert.equal(ev.filter(e => e.type === 'capture_ready').length, 1);
  s.cityStore = [{ id: 'zhaoyun', name: '赵云' }];
  capture(s, 'xuchang'); assert.equal(L.owner, null); assert.equal(s.homeCity, 'xuchang'); assert.equal(s.cityStore.length, 1);
});

test('失守：主城城防 0 且敌队在城内停 10 s → lost；变无主城 30%，存放的武将回自由池', () => {
  const s = createGameState(balance); s.cities = createCities(balance, { garrison: false });
  capture(s, 'luoyang'); s.cityStore = [{ id: 'zhaoyun', name: '赵云' }]; s.freePool = [];
  const L = s.cities.luoyang; L.def = 0; L.zeroAtS = 0;
  const foe = { id: 'w1', faction: 'wei', x: L.x, y: L.y + 20, r: 15, unit: 'inf', power: 100, soldiers: 50, siegeTarget: 'luoyang' };
  let t = 0, ev = [];
  for (let i = 0; i < 101; i++) { t = +(t + 0.1).toFixed(3); ev = ev.concat(cityTick(s.cities, [foe], ctx({ tS: t, homeCity: 'luoyang', chapter: 1 })).events); }
  assert.equal(ev.filter(e => e.type === 'lost').length, 1);
  const r = loseCity(s, 'luoyang', balance, 1);
  assert.equal(L.owner, null); assert.equal(L.def, 0.3 * 420); assert.equal(s.homeCity, null);
  assert.deepEqual(s.freePool, ['zhaoyun']); assert.equal(r.lostGenerals.length, 1);
  assert.equal(serviceCity(L), true); assert.equal(serviceCity(s.cities.xuchang), false);
});

test('换章：上限换新、当前城防按比例放大', () => {
  const cs = createCities(balance); cs.luoyang.def = 115;
  applyChapter(cs, 1, balance);
  assert.equal(cs.luoyang.def, 210); assert.equal(cs.xuchang.def, 420); assert.equal(defMax(balance, 3), 870);
});

test('AI 攻城：第 2 章起在主城待满 20 s 派兵，60 s 冷却；第 3 章起离城 500 px 外每分钟 20%', () => {
  const rc = {};
  let due = 0;
  for (let i = 0; i < 1000; i++) if (siegePlayerDue(rc, { inside: true, tS: i * 0.1, dt: 0.1, chapter: 0 }, balance)) due++;
  assert.equal(due, 0, '第 1 章不派');
  const rc2 = {}; const at = [];
  for (let i = 0; i < 1300; i++) if (siegePlayerDue(rc2, { inside: true, tS: i * 0.1, dt: 0.1, chapter: 1 }, balance)) at.push(Math.round(i * 0.1));
  assert.deepEqual(at, [20, 80]);
  const rng = mulberry32(1), rc3 = {}; let n = 0;
  for (let i = 0; i < 600 * 1000; i++) if (siegeEmptyDue(rc3, { away: true, dt: 0.1, chapter: 2 }, balance, rng)) n++;
  assert.ok(Math.abs(n / 1000 - 0.2) < 0.03, String(n));
  assert.equal(siegeEmptyDue({}, { away: true, dt: 100, chapter: 1 }, balance, rng), false);
  const cs = createCities(balance), L = cs.luoyang;
  const teams = [{ id: 'a', faction: 'wei', power: 50, x: L.x + 100, y: L.y }, { id: 'b', faction: 'wei', power: 90, x: L.x + 300, y: L.y }, { id: 'c', faction: 'qun', power: 200, x: L.x, y: L.y + 10 }];
  // 洛阳离许昌（魏）最近 → 魏；战力 ≥ 0.8×100 的最近一支 = b
  const near = ['wei', 'qun'].map(f => Object.entries(balance.v06.city.capitals).find(([, x]) => x === f)[0]);
  assert.ok(near.length === 2);
  const pick = pickSiegeTeam(L, teams, 100, new Set(), balance);
  assert.equal(pick.faction, pick.team ? pick.team.faction : pick.spawn);
  const pickNone = pickSiegeTeam(L, teams.map(t => ({ ...t, power: 10 })), 100, new Set(), balance);
  assert.ok(pickNone.spawn);
  assert.equal(pickNearbyTeam(L, teams).id, 'c');
});

// ---------------- 存档 v4（v0.5）→ v5（v0.6）----------------
import { makeSave, parseSave, SAVE_VERSION } from '../src/systems/save.js';
import { buildTeam, indexBalance, createNameAllocator } from '../src/systems/teams.js';
import { step, createCombatState, addBody, makeBody, makeCombatConfig } from '../src/systems/melee.js';

function v4Save({ chapter = 1 } = {}) {
  const idx = indexBalance(balance), rng = mulberry32(7), names = createNameAllocator(balance, rng);
  const teams = balance.initial_teams.map(d => buildTeam(d, balance, rng, idx, names).team);
  const st = createGameState(balance);
  Object.assign(st, { points: 100, gachaDraws: 5 });
  const snap = {
    gameTimeMs: 400000, state: st, player: { team: teams.find(t => t.is_player), invincibleUntil: 0, graceUntil: 0 },
    ai: teams.filter(t => !t.is_player).map(t => ({ team: t, mem: { state: 'wander' } })), spawn: { counter: 0 }, names: names.getState(), rng: {},
    run: { runId: 'r', runSeed: 1, chapter, heroHp: 80, namedDefeated: [], over: null }
  };
  const s = makeSave(snap, { balance, mapSeed: 184 });
  s.saveVersion = 4;
  delete s.state.gacha; delete s.state.cities; delete s.state.cityStore; delete s.state.homeCity;
  s.state.gachaPending = { next: 'item_full', type: 'item', cost: 85, itemId: 'war_drum' };
  return s;
}

test('存档 v4 → v5：洛阳无主空城、没有主城；旧抽卡待选丢弃并退点；抽卡次数沿用；主角成长从当前章节算起', () => {
  assert.equal(SAVE_VERSION, 5);
  const { save } = parseSave(JSON.stringify(v4Save({ chapter: 2 })), { balance, mapSeed: 184 });
  const st = save.state;
  assert.equal(save.saveVersion, 5);
  assert.equal(st.points, 185); assert.equal(st.gachaPending, null);
  assert.deepEqual(st.gacha, { n: 5, offer: null, freeRefreshUsed: [0, 0, 0, 0], sinceEpic: 0 });
  assert.equal(st.homeCity, null); assert.deepEqual(st.cityStore, []);
  assert.equal(st.cities.luoyang.owner, null); assert.equal(st.cities.luoyang.garrison, null);
  assert.equal(st.cities.xuchang.owner, 'wei'); assert.equal(st.cities.xuchang.def, 700);
  assert.equal(save.run.heroGrownCh, 2);
});

test('存档 v5 校验：主城必须是玩家的城；城池 id 必须存在', () => {
  const { save } = parseSave(JSON.stringify(v4Save()), { balance, mapSeed: 184 });
  const bad1 = structuredClone(save); bad1.state.homeCity = 'xuchang';
  assert.throws(() => parseSave(JSON.stringify(makeSave(bad1, { balance, mapSeed: 184 })), { balance, mapSeed: 184 }), /主城非法/);
  const bad2 = structuredClone(save); bad2.state.cities.nowhere = { x: 1, y: 1, def: 1 };
  assert.throws(() => parseSave(JSON.stringify(makeSave(bad2, { balance, mapSeed: 184 })), { balance, mapSeed: 184 }), /城池非法/);
});

test('melee：env.noEngage → 接触也不开战；已在打的一对按脱离处理（escape_s 后结束）', () => {
  const cfg = makeCombatConfig(combatJson, balance);
  let s = createCombatState({ seed: 1 });
  const mk = (id, faction, x) => makeBody({ id, faction, unit: 'inf', soldiers: 100, generals: [{ id: 'g', lead: 50, str: 50, int: 50, cha: 50 }], items: [], position: { x, y: 0 } }, balance, cfg);
  addBody(s, mk('a', 'player', 0)); addBody(s, mk('b', 'wei', 20));
  let prot = true;
  const env = { noEngage: () => prot };
  for (let i = 0; i < 10; i++) s = step(s, {}, cfg.tick_s, cfg, env);
  assert.equal(Object.keys(s.pairs).length, 0);
  prot = false; s = step(s, {}, cfg.tick_s, cfg, env);
  assert.equal(Object.keys(s.pairs).length, 1);
  prot = true;
  let ended = false;
  for (let i = 0; i < 40 && !ended; i++) { s = step(s, {}, cfg.tick_s, cfg, env); ended = Object.keys(s.pairs).length === 0; }
  assert.ok(ended, '保护后脱离');
});
