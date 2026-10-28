import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addGeneralOrQueue, resolvePending, replaceableIndices } from '../src/systems/roster.js';
import { createGameState } from '../src/systems/gameState.js';
import { indexBalance } from '../src/systems/teams.js';
import { computePower, soldierCap, mainGeneral } from '../src/systems/combat.js';

const balance = JSON.parse(readFileSync(new URL('../src/data/balance.json', import.meta.url)));
const idx = indexBalance(balance);
const G = id => ({ ...idx.generalsById[id] });
const full = () => ({ id: 'player', is_player: true, soldiers: 50, generals: [{ ...balance.hero }, G('liaohua'), { id: 'p_gen', name: '波才', generic: true, lead: 30, str: 40, int: 20, cha: 20 }], items: [] });

test('未满直接入队，满编排队（先进先出）', () => {
  const s = createGameState(balance), t = { generals: [{ ...balance.hero }], items: [] };
  assert.equal(addGeneralOrQueue(s, t, G('lvbu'), { source: 'capture' }, balance).joined, true);
  const f = full();
  addGeneralOrQueue(s, f, G('zhaoyun'), { source: 'gacha', from: '抽卡' }, balance);
  addGeneralOrQueue(s, f, G('lvbu'), { source: 'capture', from: '吕布军' }, balance);
  assert.deepEqual(s.pendingGenerals.map(p => p.general.id), ['zhaoyun', 'lvbu']);
});

test('主角不可替换', () => {
  assert.deepEqual(replaceableIndices(full(), balance), [1, 2]);
  const s = createGameState(balance), t = full();
  s.pendingGenerals.push({ general: G('lvbu'), source: 'capture' });
  assert.throws(() => resolvePending(s, t, 'replace', 0, balance));
});

test('替换：新将入队；被替换名将回自由池、头目消失；战力/上限随之变化', () => {
  const s = createGameState(balance), t = full();
  const p0 = computePower(t, balance), c0 = soldierCap(t, balance);
  s.pendingGenerals.push({ general: G('zhaoyun'), source: 'gacha' }, { general: G('lvbu'), source: 'capture' });
  const r1 = resolvePending(s, t, 'replace', 1, balance);
  assert.equal(r1.replaced.id, 'liaohua'); assert.ok(s.freePool.includes('liaohua'));
  assert.equal(t.generals[1].id, 'zhaoyun');
  assert.equal(mainGeneral(t, balance).id, 'zhaoyun'); // 统率最高
  assert.ok(computePower(t, balance) > p0 && soldierCap(t, balance) > c0);
  const poolLen = s.freePool.length;
  resolvePending(s, t, 'replace', 2, balance); // 替换黄巾头目
  assert.equal(s.freePool.length, poolLen); // 头目不进自由池
  assert.deepEqual(t.generals.map(g => g.id), ['hero', 'zhaoyun', 'lvbu']);
  assert.equal(s.pendingGenerals.length, 0);
});

test('释放：名将回自由池，+release_captive_points；头目消失', () => {
  const s = createGameState(balance), t = full();
  s.pendingGenerals.push({ general: G('lvbu'), source: 'capture' }, { general: { id: 'x', name: '管亥', generic: true, lead: 1, str: 1, int: 1, cha: 1 }, source: 'capture' });
  const r = resolvePending(s, t, 'release', null, balance);
  assert.equal(r.points, balance.rewards.release_captive_points);
  assert.equal(s.points, 20); assert.ok(s.freePool.includes('lvbu'));
  resolvePending(s, t, 'release', null, balance);
  assert.ok(!s.freePool.includes('x')); assert.equal(s.points, 40);
  assert.equal(t.generals.length, 3);
});

test('v0.4 释放：无论来源（俘获 / 抽卡）都 +release_captive_points', () => {
  for (const source of ['capture', 'gacha']) {
    const s = createGameState(balance), t = full();
    s.pendingGenerals.push({ general: G('zhaoyun'), source });
    const r = resolvePending(s, t, 'release', null, balance);
    assert.equal(r.points, 20, source); assert.equal(s.points, 20, source); assert.ok(s.freePool.includes('zhaoyun'));
  }
});

// ---------------- v0.6 名册（roster_v06）：游戏实际配置 ----------------
import { balance as B6 } from '../src/data/index.js';
import { canStore, storeCap, swapWithStore, loseStore, pendingPreview, rosterFlowStep, newRosterFlow, exilePoints } from '../src/systems/roster.js';
import { getLeader } from '../src/systems/leader.js';
const s6 = (over = {}) => ({ ...createGameState(B6), ...over });

test('v0.6：上限 3（主角 + 2 副将）；流放 = 回自由池 + 20 点；送回主城要有主城且有空位', () => {
  assert.equal(B6.team_rules.max_generals, 3); assert.equal(exilePoints(B6), 20); assert.equal(storeCap(B6), 3);
  const s = s6(), t = full();
  s.pendingGenerals.push({ general: G('zhaoyun'), source: 'gacha' });
  assert.equal(canStore(s, B6), false);
  assert.throws(() => resolvePending(s, t, 'to_city', null, B6), /主城/);
  const r = resolvePending(s, t, 'exile', null, B6);
  assert.equal(r.points, 20); assert.equal(s.points, 20); assert.ok(s.freePool.includes('zhaoyun'));
  s.homeCity = 'luoyang'; s.pendingGenerals.push({ general: G('lvbu'), source: 'capture' });
  resolvePending(s, t, 'to_city', null, B6);
  assert.deepEqual(s.cityStore.map(g => g.id), ['lvbu']);
});

test('v0.6：替换副将 → 换下的人去主城（有空位）或流放（+20）；统帅仍是主角', () => {
  const s = s6({ homeCity: 'luoyang' }), t = full();
  s.pendingGenerals.push({ general: G('zhaoyun'), source: 'gacha' }, { general: G('lvbu'), source: 'capture' }, { general: G('zhangfei'), source: 'capture' });
  const r1 = resolvePending(s, t, 'replace', 1, B6, { dest: 'city' });
  assert.equal(r1.replaced.id, 'liaohua'); assert.deepEqual(s.cityStore.map(g => g.id), ['liaohua']);
  assert.equal(getLeader(t, B6).id, 'hero');
  const r2 = resolvePending(s, t, 'replace', 2, B6, { dest: 'exile' }); // 换下黄巾头目 → 消失，+20
  assert.equal(r2.points, 20); assert.ok(!s.freePool.includes('p_gen'));
  s.cityStore.push(G('guanyu'), G('caocao')); // 主城满 3
  const r3 = resolvePending(s, t, 'replace', 1, B6); // 缺省：主城满 → 流放
  assert.equal(r3.dest, 'exile'); assert.ok(s.freePool.includes('zhaoyun'));
  assert.throws(() => { s.pendingGenerals.push({ general: G('liubei' in idx.generalsById ? 'liubei' : 'zhouyu'), source: 'gacha' }); resolvePending(s, t, 'replace', 1, B6, { dest: 'city' }); }, /主城/);
});

test('v0.6：主城存放对调 / 取出 / 存入；主角不能存；失守 → 存放的武将回自由池', () => {
  const s = s6({ homeCity: 'luoyang', cityStore: [G('zhaoyun')] }), t = full();
  swapWithStore(s, t, 1, 0, B6);
  assert.equal(t.generals[1].id, 'zhaoyun'); assert.equal(s.cityStore[0].id, 'liaohua');
  assert.throws(() => swapWithStore(s, t, 0, 0, B6), /主角/);
  assert.throws(() => swapWithStore(s, t, null, 0, B6), /已满/);
  swapWithStore(s, t, 2, null, B6); assert.equal(t.generals.length, 2); assert.equal(s.cityStore.length, 2);
  swapWithStore(s, t, null, 0, B6); assert.equal(t.generals.length, 3);
  const lost = loseStore(s);
  assert.equal(lost.length, 1); assert.equal(s.cityStore.length, 0);
});

test('v0.6：弹窗状态机 PENDING_GENERAL → CHOOSE_REPLACE → CHOOSE_DEST → CONFIRM_EXILE → DONE；流放需确认；没主城时送回主城无效', () => {
  const ctx = { canCity: false, replaceable: [1, 2] };
  let f = newRosterFlow();
  assert.equal(rosterFlowStep(f, { type: 'to_city' }, ctx).ui, 'PENDING_GENERAL');
  f = rosterFlowStep(f, { type: 'replace' }, ctx); assert.equal(f.ui, 'CHOOSE_REPLACE');
  assert.equal(rosterFlowStep(f, { type: 'pick', index: 0 }, ctx).ui, 'CHOOSE_REPLACE'); // 主角不可选
  assert.equal(rosterFlowStep(f, { type: 'back' }, ctx).ui, 'PENDING_GENERAL');
  f = rosterFlowStep(f, { type: 'pick', index: 2 }, ctx); assert.equal(f.ui, 'CHOOSE_DEST'); assert.equal(f.replaceIdx, 2);
  assert.equal(rosterFlowStep(f, { type: 'to_city' }, ctx).ui, 'CHOOSE_DEST');
  const conf = rosterFlowStep(f, { type: 'exile' }, ctx);
  assert.equal(conf.ui, 'CONFIRM_EXILE'); assert.equal(conf.confirmKind, 'exile_replaced');
  assert.equal(rosterFlowStep(conf, { type: 'back' }, ctx).ui, 'CHOOSE_DEST'); // Esc 取消
  const d = rosterFlowStep(conf, { type: 'confirm' }, ctx);
  assert.equal(d.ui, 'DONE'); assert.deepEqual(d.resolve, ['replace', 2, { dest: 'exile' }]);
  assert.deepEqual(rosterFlowStep(conf, { type: 'exile' }, ctx).resolve, ['replace', 2, { dest: 'exile' }], '再按 R 也确认');
  // 满编弹窗直接流放新武将：也要确认
  let f2 = rosterFlowStep(newRosterFlow(), { type: 'exile' }, ctx);
  assert.equal(f2.ui, 'CONFIRM_EXILE'); assert.equal(f2.confirmKind, 'exile_new');
  assert.equal(rosterFlowStep(f2, { type: 'back' }, ctx).ui, 'PENDING_GENERAL');
  assert.deepEqual(rosterFlowStep(f2, { type: 'confirm' }, ctx).resolve, ['exile', null]);
  const c = rosterFlowStep(rosterFlowStep(newRosterFlow(), { type: 'pick', index: 1 }, { ...ctx, canCity: true }), { type: 'to_city' }, { ...ctx, canCity: true });
  assert.deepEqual(c.resolve, ['replace', 1, { dest: 'city' }]);
  assert.deepEqual(rosterFlowStep(newRosterFlow(), { type: 'to_city' }, { ...ctx, canCity: true }).resolve, ['to_city', null]);
  // 去向页流放按钮文字用 exilePoints（20），源码不含字面 +26
  const src = readFileSync(new URL('../src/scenes/RosterScene.js', import.meta.url), 'utf8');
  assert.match(src, /exilePoints\(balance\)/);
  assert.doesNotMatch(src, /流放[^\n]{0,40}\+26/); // 流放按钮不得写死错误点数
  assert.equal(exilePoints(B6), 20);
});

test('v0.6：战力预览「换下后战力 旧 → 新」/「作为副将：战力 旧 → 新」= computePower', () => {
  const t = full(), g = G('zhaoyun');
  const pv = pendingPreview(t, g, B6, computePower);
  assert.equal(pv.asDeputy, null);
  assert.deepEqual(pv.replace.map(r => r.index), [1, 2]);
  assert.equal(pv.replace[0].after, computePower({ ...t, generals: [t.generals[0], g, t.generals[2]] }, B6));
  const t2 = { ...full(), generals: [{ ...B6.hero }] };
  const pv2 = pendingPreview(t2, g, B6, computePower);
  assert.ok(pv2.asDeputy.after > pv2.asDeputy.before);
});
