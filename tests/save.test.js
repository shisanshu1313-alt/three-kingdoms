import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SAVE_VERSION, makeSave, serialize, parseSave, loadSave, writeSave, clearSave, hasSave, migrate, validateSave,
  memToSave, memFromSave, restoreGameState
} from '../src/systems/save.js';
import { buildTeam, indexBalance, createNameAllocator } from '../src/systems/teams.js';
import { createGameState } from '../src/systems/gameState.js';
import { mulberry32 } from '../src/systems/rng.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const idx = indexBalance(balance);
const MAP_SEED = 184;
const ctx = { balance, mapSeed: MAP_SEED };

import { MemoryStorageAdapter, LocalStorageAdapter, createDefaultStorage } from '../src/platform/storage.js';
const memStorage = () => new MemoryStorageAdapter();

/** 构造一份“玩过一会儿”的快照：强化过的属性、物品、待安排武将、AI 记忆、名字池消耗、随机数状态 */
function sampleSnapshot() {
  const rng = mulberry32(2026), names = createNameAllocator(balance, rng);
  const teams = balance.initial_teams.map(d => buildTeam(d, balance, rng, idx, names).team);
  const player = teams.find(t => t.is_player);
  player.generals[0].str = 57; player.generals.push({ ...idx.generalsById.liaohua, lead: 70 });
  player.items = ['war_drum', 'fine_horse']; player.soldiers = 123; player.position = { x: 1234.5, y: 987.25 };
  const st = createGameState(balance);
  Object.assign(st, { points: 345, gachaDraws: 7, battles: 4 });
  st.freePool = st.freePool.filter(id => id !== 'zhaoyun');
  st.pendingGenerals.push({ general: { ...idx.generalsById.lvbu }, source: 'capture', from: '吕布军' });
  st.captured.push({ ...idx.generalsById.liaohua });
  st.battleLog.unshift({ time: 12345, text: '主角军 胜 黄巾军·波才' });
  const nowMs = 50000;
  return {
    gameTimeMs: nowMs,
    state: st,
    player: { team: player, mainGeneralId: 'liaohua', invincibleUntil: nowMs + 1500, graceUntil: nowMs },
    ai: teams.filter(t => !t.is_player).map((t, i) => ({
      team: t, graceUntil: nowMs + i * 100,
      mem: memToSave({ state: i % 2 ? 'chase' : 'wander', targetId: i % 2 ? 'player' : null, since: 40, ignore: { bandit_1: 55, gone: 10 }, idleUntil: nowMs + 2000, nextReplan: 0 }, nowMs)
    })),
    spawn: { counter: 3 },
    timers: { respawn: nowMs + 4200, autosave: nowMs + 30000 },
    names: names.getState(),
    rng: { team: rng.getState() },
    pairCooldowns: [['bandit_1|player', 2500]],
    camera: { zoom: 1.3 }
  };
}

test('往返：snapshot → 存档 → JSON → 读档，与原快照深度相等', () => {
  const snap = sampleSnapshot();
  const save = makeSave(snap, { balance, mapSeed: MAP_SEED, reason: 'manual', now: new Date('2026-10-22T08:00:00Z') });
  const { save: back, warnings } = parseSave(serialize(save), ctx);
  assert.deepEqual(warnings, []);
  assert.deepEqual(back, save);
  const { saveVersion, balanceVersion, mapSeed, savedAt, reason, ...rest } = back;
  assert.deepEqual(rest, structuredClone(snap));
  assert.equal(saveVersion, SAVE_VERSION); assert.equal(balanceVersion, balance._meta.version); assert.equal(mapSeed, MAP_SEED);
  assert.equal(savedAt, '2026-10-22T08:00:00.000Z'); assert.equal(reason, 'manual');
});

test('往返：gameState 还原后与原来深度相等；缺字段补默认值', () => {
  const snap = sampleSnapshot();
  const back = parseSave(serialize(makeSave(snap, { balance, mapSeed: MAP_SEED })), ctx).save;
  assert.deepEqual(restoreGameState(back.state, createGameState(balance)), snap.state);
  const partial = restoreGameState({ points: 5 }, createGameState(balance));
  assert.equal(partial.points, 5); assert.deepEqual(partial.pendingGenerals, []);
});

test('往返：名字池 / 随机数状态还原后继续产生相同序列', () => {
  const rng = mulberry32(2026), names = createNameAllocator(balance, rng);
  for (let i = 0; i < 3; i++) names();
  const saved = JSON.parse(JSON.stringify({ n: names.getState(), r: rng.getState() }));
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

test('localStorage：写入 / 读取 / 清除；没有存档 → empty', () => {
  const s = memStorage();
  assert.equal(hasSave(s), false);
  assert.deepEqual(loadSave(ctx, s), { ok: false, code: 'empty', message: '没有存档' });
  const save = makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED });
  assert.equal(writeSave(save, s), true);
  const r = loadSave(ctx, s);
  assert.equal(r.ok, true); assert.deepEqual(r.save, save);
  clearSave(s); assert.equal(hasSave(s), false);
  // setItem 抛异常（配额满等）不崩溃
  assert.equal(writeSave(save, { set() { throw new Error('QuotaExceeded'); }, get: () => null, remove() {} }), false);
  assert.equal(loadSave(ctx, { get() { throw new Error('SecurityError'); } }).code, 'empty'); // get 抛异常 → 当作没有存档
});

test('损坏数据：非 JSON / 截断 / 非对象 / 缺版本号 / 字段非法 → corrupt，不抛异常', () => {
  const s = memStorage(), good = serialize(makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED }));
  const cases = {
    notJson: '{{{not json', truncated: good.slice(0, good.length / 2), nullJson: 'null', array: '[]', noVersion: '{"state":{}}',
    badPoints: good.replace('"points":345', '"points":-1'),
    unknownGeneral: good.replace('"id":"liaohua"', '"id":"nobody"'),
    unknownItem: good.replace('"fine_horse"', '"laser_gun"'),
    noPlayer: JSON.stringify({ ...JSON.parse(good), player: null }),
    heroMissing: (() => { const o = JSON.parse(good); o.player.team.generals = o.player.team.generals.filter(g => g.id !== 'hero'); return JSON.stringify(o); })(),
    nanPos: (() => { const o = JSON.parse(good); o.ai[0].team.position = { x: 'a', y: 1 }; return JSON.stringify(o); })(),
    attrOver: (() => { const o = JSON.parse(good); o.player.team.generals[0].lead = 101; return JSON.stringify(o); })()
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

test('迁移 v1 → v2：剩余时长换成游戏时钟上的绝对时刻', () => {
  const v2 = makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED });
  const T = v2.gameTimeMs;
  // 手工构造对应的 v1 存档（存剩余时长）
  const v1 = structuredClone(v2);
  v1.saveVersion = 1;
  v1.player = { team: v2.player.team, mainGeneralId: v2.player.mainGeneralId, invincibleMs: v2.player.invincibleUntil - T, graceMs: 0 };
  v1.ai = v2.ai.map(a => ({ team: a.team, graceMs: a.graceUntil - T,
    mem: { state: a.mem.state, targetId: a.mem.targetId, sinceAgoS: T / 1000 - a.mem.since, ignore: Object.fromEntries(Object.entries(a.mem.ignore).map(([k, u]) => [k, u - T / 1000])), idleMs: a.mem.idleUntil - T } }));
  v1.spawn = { counter: v2.spawn.counter, nextMs: v2.timers.respawn - T };
  delete v1.timers;
  v1.pairCooldowns = v2.pairCooldowns.map(([k, u]) => [k, u - T]);
  const { save } = parseSave(serialize(v1), ctx);
  assert.equal(save.saveVersion, 2);
  assert.deepEqual(save.player, v2.player);
  assert.deepEqual(save.ai, v2.ai);
  assert.deepEqual(save.spawn, v2.spawn);
  assert.equal(save.timers.respawn, v2.timers.respawn);
  assert.deepEqual(save.pairCooldowns, v2.pairCooldowns);
});

test('迁移钩子：旧版本按 MIGRATIONS 逐级升级；缺迁移 → incompatible', () => {
  const cur = makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED });
  // 假装当前存档其实是 v0（没有 camera 字段），用迁移补上
  const old = { ...structuredClone(cur), saveVersion: SAVE_VERSION - 1 }; delete old.camera;
  const migrations = { [SAVE_VERSION - 1]: s => ({ ...s, saveVersion: SAVE_VERSION, camera: { zoom: 1 } }) }; // 自定义迁移表
  const r = parseSave(serialize(old), { ...ctx, migrations });
  assert.equal(r.save.saveVersion, SAVE_VERSION); assert.deepEqual(r.save.camera, { zoom: 1 });
  assert.throws(() => parseSave(serialize(old), { ...ctx, migrations: {} }), e => e.code === 'incompatible');
  assert.throws(() => migrate(old, { [SAVE_VERSION - 1]: s => s }), e => e.code === 'incompatible'); // 没提升版本号
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
  const save = makeSave(sampleSnapshot(), { balance, mapSeed: MAP_SEED });
  writeSave(save, a); assert.deepEqual(loadSave(ctx, a).save, save);
});
