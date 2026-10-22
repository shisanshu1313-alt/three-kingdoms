import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SAVE_VERSION, makeSave, serialize, parseSave, loadSave, writeSave, clearSave, hasSave, migrate, validateSave,
  memToSave, memFromSave, restoreGameState, encodeGeneral, decodeGeneral
} from '../src/systems/save.js';
import { buildTeam, indexBalance, createNameAllocator } from '../src/systems/teams.js';
import { createGameState } from '../src/systems/gameState.js';
import { mulberry32 } from '../src/systems/rng.js';
import { MemoryStorageAdapter, LocalStorageAdapter, createDefaultStorage } from '../src/platform/storage.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const idx = indexBalance(balance);
const MAP_SEED = 184;
const ctx = { balance, mapSeed: MAP_SEED };
const memStorage = () => new MemoryStorageAdapter();
const json = o => JSON.parse(JSON.stringify(o));
/** 运行时武将的标准形式（与 buildTeam / gacha / decodeGeneral 一致） */
const G = (id, over = {}) => { const b = idx.generalsById[id]; const g = { id: b.id, name: b.name }; if (b.tier) g.tier = b.tier; for (const a of ['lead', 'str', 'int', 'cha']) g[a] = b[a]; return { ...g, ...over }; };

/** 一份“玩过一会儿”的快照：强化过的属性、物品、待安排武将、AI 记忆、名字池消耗、随机数状态、进行中的战斗、未完成的抽卡选择 */
function sampleSnapshot() {
  const rng = mulberry32(2026), names = createNameAllocator(balance, rng);
  const teams = balance.initial_teams.map(d => buildTeam(d, balance, rng, idx, names).team);
  const player = teams.find(t => t.is_player);
  player.generals[0].str = 57; player.generals.push(G('liaohua', { lead: 70 }));
  player.items = ['war_drum', 'fine_horse']; player.soldiers = 123; player.position = { x: 1234.5, y: 987.25 };
  const st = createGameState(balance);
  Object.assign(st, { points: 345, gachaDraws: 7, battles: 4 });
  st.freePool = st.freePool.filter(id => id !== 'zhaoyun');
  st.pendingGenerals.push({ general: G('lvbu'), source: 'capture', from: '吕布军' });
  st.captured.push(G('liaohua'));
  st.battleLog.unshift({ time: 12345, text: '主角军 胜 黄巾军·波才' });
  st.gachaPending = { next: 'item_full', type: 'item', rolledType: 'item', fallback: null, cost: 85, text: '物品栏已满', itemId: 'banner' };
  const nowMs = 50000;
  const ai = teams.filter(t => !t.is_player);
  return {
    gameTimeMs: nowMs,
    state: st,
    player: { team: player, mainGeneralId: 'liaohua', invincibleUntil: nowMs + 1500, graceUntil: nowMs },
    ai: ai.map((t, i) => ({
      team: t, graceUntil: nowMs + i * 100,
      mem: memToSave({ state: i % 2 ? 'chase' : 'wander', targetId: i % 2 ? 'player' : null, since: 40, ignore: { bandit_1: 55, gone: 10 }, idleUntil: nowMs + 2000, nextReplan: 0 }, nowMs)
    })),
    spawn: { counter: 3 },
    timers: { respawn: nowMs + 4200, autosave: nowMs + 30000 },
    names: names.getState(),
    rng: { team: rng.getState(), gacha: 123456, combat: 654321 },
    battles: [{ a: ai[0].id, b: ai[1].id, result: { outcome: 'a_wins', winner: ai[0].id, ratio: 1.5 }, startAt: 49000, endAt: 53000, lossOf: { [ai[0].id]: 3 }, startSoldiers: { [ai[0].id]: 100 } }],
    pairCooldowns: [['bandit_1|player', 52500]],
    camera: { zoom: 1.3 }
  };
}
const metaOf = s => ({ saveVersion: s.saveVersion, balanceVersion: s.balanceVersion, mapSeed: s.mapSeed, savedAt: s.savedAt, reason: s.reason });

test('往返：snapshot → 存档 → JSON → 读档，与原快照深度相等（含进行中的战斗 / 抽卡待选择 / 随机数流）', () => {
  const snap = sampleSnapshot();
  const save = makeSave(snap, { balance, mapSeed: MAP_SEED, reason: 'manual', now: new Date('2026-10-22T08:00:00Z') });
  const { save: back, warnings } = parseSave(serialize(save), ctx);
  assert.deepEqual(warnings, []);
  assert.deepEqual(back, { ...metaOf(save), ...json(snap) });
  assert.equal(back.saveVersion, SAVE_VERSION); assert.equal(back.balanceVersion, balance._meta.version);
  assert.equal(back.savedAt, '2026-10-22T08:00:00.000Z'); assert.equal(back.reason, 'manual');
});

test('v3 武将编码：名将只存 id + 成长值；头目存完整属性', () => {
  const save = makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED });
  const pg = save.player.team.generals;
  assert.deepEqual(pg, [{ id: 'hero', growth: { str: 12 } }, { id: 'liaohua', growth: { lead: 2 } }]);
  assert.deepEqual(save.state.pendingGenerals[0].general, { id: 'lvbu' });
  assert.deepEqual(save.state.captured, [{ id: 'liaohua' }]);
  const head = save.ai.map(a => a.team.generals).flat().find(g => g.generic);
  assert.ok(head && typeof head.lead === 'number' && head.name);
  assert.deepEqual(encodeGeneral(G('zhaoyun'), balance), { id: 'zhaoyun' });
});

test('v3 读档：基础属性取当前配置（策划改数值会生效），成长值叠加，截到 attr_cap', () => {
  const text = serialize(makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED }));
  const b2 = structuredClone(balance);
  b2.hero.str = 50;                                     // 主角基础武力 45 → 50，成长 +12 → 62
  b2.generals.find(g => g.id === 'liaohua').lead = 99;   // 基础 99 + 成长 2 → 截到 100
  b2.generals.find(g => g.id === 'lvbu').name = '吕奉先';
  const { save } = parseSave(text, { balance: b2, mapSeed: MAP_SEED });
  assert.equal(save.player.team.generals[0].str, 62);
  assert.equal(save.player.team.generals[1].lead, 100);
  assert.equal(save.state.pendingGenerals[0].general.name, '吕奉先');
  assert.deepEqual(decodeGeneral({ id: 'hero', growth: { cha: -500 } }, balance).cha, 0);
});

test('往返：gameState 还原后与原来深度相等；缺字段补默认值', () => {
  const snap = sampleSnapshot();
  const back = parseSave(serialize(makeSave(snap, { balance, mapSeed: MAP_SEED })), ctx).save;
  assert.deepEqual(restoreGameState(back.state, createGameState(balance)), json(snap.state));
  const partial = restoreGameState({ points: 5 }, createGameState(balance));
  assert.equal(partial.points, 5); assert.deepEqual(partial.pendingGenerals, []); assert.equal(partial.gachaPending, null);
});

test('往返：名字池 / 随机数状态还原后继续产生相同序列', () => {
  const rng = mulberry32(2026), names = createNameAllocator(balance, rng);
  for (let i = 0; i < 3; i++) names();
  const saved = json({ n: names.getState(), r: rng.getState() });
  const expect = [names(), names(), rng()];
  const rng2 = mulberry32(1), names2 = createNameAllocator(balance, rng2);
  rng2.setState(saved.r); names2.setState(saved.n);
  assert.deepEqual([names2(), names2(), rng2()], expect);
});

test('AI 记忆：游戏时钟绝对时间原样保存；过期忽略项被丢弃；nextReplan 归零', () => {
  const m = memToSave({ state: 'chase', targetId: 'player', since: 40, ignore: { a: 55, b: 10 }, idleUntil: 52000, nextReplan: 999, personality: { key: 'normal' } }, 50000);
  assert.deepEqual(m, { state: 'chase', targetId: 'player', since: 40, ignore: { a: 55 }, idleUntil: 52000 });
  assert.deepEqual(memFromSave(m), { state: 'chase', targetId: 'player', since: 40, ignore: { a: 55 }, idleUntil: 52000, nextReplan: 0 });
});

test('存储：写入 / 读取 / 清除；没有存档 → empty；存储抛异常不崩溃', () => {
  const s = memStorage();
  assert.equal(hasSave(s), false);
  assert.deepEqual(loadSave(ctx, s), { ok: false, code: 'empty', message: '没有存档' });
  const snap = sampleSnapshot();
  const save = makeSave(snap, { balance, mapSeed: MAP_SEED });
  assert.equal(writeSave(save, s), true);
  const r = loadSave(ctx, s);
  assert.equal(r.ok, true); assert.deepEqual(r.save, { ...metaOf(save), ...json(snap) });
  clearSave(s); assert.equal(hasSave(s), false);
  assert.equal(writeSave(save, { set() { throw new Error('QuotaExceeded'); }, get: () => null, remove() {} }), false);
  assert.equal(loadSave(ctx, { get() { throw new Error('SecurityError'); } }).code, 'empty');
});

test('损坏数据：非 JSON / 截断 / 非对象 / 缺版本号 / 字段非法 → corrupt，不抛异常', () => {
  const s = memStorage(), good = serialize(makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED }));
  const mod = fn => { const o = JSON.parse(good); fn(o); return JSON.stringify(o); };
  const cases = {
    notJson: '{{{not json', truncated: good.slice(0, good.length / 2), nullJson: 'null', array: '[]', noVersion: '{"state":{}}',
    badPoints: good.replace('"points":345', '"points":-1'),
    unknownGeneral: mod(o => { o.player.team.generals[1].id = 'nobody'; }),
    unknownItem: good.replace('"fine_horse"', '"laser_gun"'),
    noPlayer: mod(o => { o.player = null; }),
    heroMissing: mod(o => { o.player.team.generals = o.player.team.generals.filter(g => g.id !== 'hero'); }),
    nanPos: mod(o => { o.ai[0].team.position = { x: 'a', y: 1 }; }),
    headAttrOver: mod(o => { o.ai.find(a => a.team.generals.some(g => g.generic)).team.generals.find(g => g.generic).lead = 101; }),
    badGrowth: mod(o => { o.player.team.generals[0].growth = { str: 'x' }; }),
    badBattle: mod(o => { o.battles[0].a = 'ghost'; }),
    badGachaPending: mod(o => { o.state.gachaPending = { next: 'item_full', itemId: 'laser_gun' }; })
  };
  for (const [name, text] of Object.entries(cases)) {
    s.set('sanguo-save', text);
    const r = loadSave(ctx, s);
    assert.equal(r.ok, false, name); assert.equal(r.code, 'corrupt', name); assert.ok(r.message.length > 0, name);
  }
});

test('版本：更新版本的存档 → too_new；地图种子不同 → incompatible；数值版本不同 → 可读但给 warning', () => {
  const save = makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED });
  assert.throws(() => parseSave(serialize({ ...save, saveVersion: SAVE_VERSION + 1 }), ctx), e => e.code === 'too_new');
  assert.throws(() => parseSave(serialize({ ...save, mapSeed: 999 }), ctx), e => e.code === 'incompatible');
  const r = parseSave(serialize({ ...save, balanceVersion: '0.2' }), ctx);
  assert.equal(r.warnings.length, 1); assert.ok(r.warnings[0].includes('v0.2') && r.warnings[0].includes(`v${balance._meta.version}`));
});

/** 当前快照对应的 v2 存档（武将完整属性、计时为绝对时刻） */
function asV2(snap) {
  const s = { saveVersion: 2, balanceVersion: balance._meta.version, mapSeed: MAP_SEED, savedAt: '2026-10-22T08:00:00.000Z', reason: 'auto', ...json(snap) };
  delete s.battles; delete s.state.gachaPending; s.rng = { team: s.rng.team }; // v2 没有这些字段
  return s;
}

test('迁移 v2 → v3：成长值 = 存档属性 − 当前配置基础值（负数按 0）', () => {
  const snap = sampleSnapshot();
  const v2 = asV2(snap);
  v2.ai[0].team.generals[0] = { ...v2.ai[0].team.generals[0] };
  const lowId = v2.ai.map(a => a.team.generals).flat().find(g => !g.generic && g.id !== 'hero').id;
  for (const a of v2.ai) for (const g of a.team.generals) if (g.id === lowId) g.str = 1; // 比配置还低 → 成长 0
  const { save } = parseSave(serialize(v2), ctx);
  assert.equal(save.saveVersion, SAVE_VERSION);
  assert.deepEqual(save.player, json(snap.player));
  assert.deepEqual(save.state.pendingGenerals, json(snap.state.pendingGenerals));
  const low = save.ai.map(a => a.team.generals).flat().find(g => g.id === lowId);
  assert.equal(low.str, idx.generalsById[lowId].str);
  assert.equal(save.battles, undefined); // v2 没有进行中的战斗，读档后按没有处理
});

test('迁移 v1 → v3：剩余时长换成绝对时刻，武将换成成长值', () => {
  const snap = sampleSnapshot();
  const v2 = asV2(snap), T = v2.gameTimeMs;
  const v1 = structuredClone(v2);
  v1.saveVersion = 1;
  v1.player = { team: v2.player.team, mainGeneralId: v2.player.mainGeneralId, invincibleMs: v2.player.invincibleUntil - T, graceMs: v2.player.graceUntil - T };
  v1.ai = v2.ai.map(a => ({ team: a.team, graceMs: a.graceUntil - T,
    mem: { state: a.mem.state, targetId: a.mem.targetId, sinceAgoS: T / 1000 - a.mem.since, ignore: Object.fromEntries(Object.entries(a.mem.ignore).map(([k, u]) => [k, u - T / 1000])), idleMs: a.mem.idleUntil - T } }));
  v1.spawn = { counter: v2.spawn.counter, nextMs: v2.timers.respawn - T };
  delete v1.timers;
  v1.pairCooldowns = v2.pairCooldowns.map(([k, u]) => [k, u - T]);
  const { save } = parseSave(serialize(v1), ctx);
  assert.equal(save.saveVersion, SAVE_VERSION);
  assert.deepEqual(save.player, json(snap.player));
  assert.deepEqual(save.ai, json(snap.ai));
  assert.deepEqual(save.spawn, snap.spawn);
  assert.equal(save.timers.respawn, snap.timers.respawn);
  assert.deepEqual(save.pairCooldowns, snap.pairCooldowns);
});

test('迁移钩子：旧版本按 MIGRATIONS 逐级升级；缺迁移 → incompatible', () => {
  const cur = makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED });
  const old = { ...structuredClone(cur), saveVersion: SAVE_VERSION - 1 }; delete old.camera;
  const migrations = { [SAVE_VERSION - 1]: s => ({ ...s, saveVersion: SAVE_VERSION, camera: { zoom: 1 } }) };
  const r = parseSave(serialize(old), { ...ctx, migrations });
  assert.equal(r.save.saveVersion, SAVE_VERSION); assert.deepEqual(r.save.camera, { zoom: 1 });
  assert.throws(() => parseSave(serialize(old), { ...ctx, migrations: {} }), e => e.code === 'incompatible');
  assert.throws(() => migrate(old, { [SAVE_VERSION - 1]: s => s }), e => e.code === 'incompatible');
});

test('validateSave：正常存档无错误', () => {
  assert.deepEqual(validateSave(makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED }), balance), []);
});

test('平台存储：LocalStorageAdapter 包装 get/set/remove；node 里没有 localStorage 时默认退回内存实现', () => {
  const m = new Map();
  const fake = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
  const a = new LocalStorageAdapter(fake);
  a.set('k', 'v'); assert.equal(a.get('k'), 'v'); a.remove('k'); assert.equal(a.get('k'), null);
  assert.ok(createDefaultStorage() instanceof MemoryStorageAdapter);
  const snap = sampleSnapshot();
  const save = makeSave(snap, { balance, mapSeed: MAP_SEED });
  writeSave(save, a); assert.deepEqual(loadSave(ctx, a).save, { ...metaOf(save), ...json(snap) });
});
