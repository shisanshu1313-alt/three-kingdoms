// F2 调试菜单（仅开发模式）用的工具：选城逻辑（纯函数）+ 填满队伍 / 给主城的流程（用假的 world）。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balance } from '../src/data/index.js';
import { createCities, PLAYER, capture } from '../src/systems/city.js';
import { pickDevHomeCity, applyDevHomeCity, applyDevFillTeams, fillTeamsText } from '../src/systems/devTools.js';

test('F2-2 选城：没有主城 → 最近的无主城（开局 = 有守军的洛阳）；有主城 → 最近的另一座无主城走迁都；没有无主城 → 最近的大本营临时设无主', () => {
  const cs = createCities(balance), L = cs.luoyang;
  assert.deepEqual(pickDevHomeCity(cs, null, { x: L.x, y: L.y + 220 }), { mode: 'home', cityId: 'luoyang', freed: false });
  const state = { cities: cs, homeCity: null };
  capture(state, 'luoyang');
  const r = pickDevHomeCity(cs, 'luoyang', { x: L.x, y: L.y });
  assert.equal(r.mode, 'relocate'); assert.equal(r.freed, true, '开局其他城都是势力大本营');
  assert.notEqual(r.cityId, 'luoyang');
  cs[r.cityId].owner = null;
  assert.deepEqual(pickDevHomeCity(cs, 'luoyang', { x: L.x, y: L.y }), { mode: 'relocate', cityId: r.cityId, freed: false });
});

test('F2-2 流程：没有主城 → 撤掉洛阳守军并立为主城；再来一次 → 触发迁都弹窗（onCaptureReady）', () => {
  const cs = createCities(balance), L = cs.luoyang;
  const removed = [], prompts = [];
  const world = {
    state: { cities: cs, homeCity: null }, player: { x: L.x, y: L.y + 220 },
    aiParties: [{ id: 'garrison_luoyang', team: { cityHold: 'luoyang' } }, { id: 'x', team: {} }],
    removeParty(p) { removed.push(p.id); this.aiParties = this.aiParties.filter(q => q !== p); },
    captureCity(id) { return capture(this.state, id).city; },
    onCaptureReady(c) { prompts.push(c.id); }
  };
  assert.match(applyDevHomeCity(world), /洛阳/);
  assert.equal(world.state.homeCity, 'luoyang'); assert.equal(L.owner, PLAYER); assert.equal(L.garrison, null);
  assert.deepEqual(removed, ['garrison_luoyang']);
  assert.match(applyDevHomeCity(world), /迁都/);
  assert.equal(prompts.length, 1); assert.equal(world.state.homeCity, 'luoyang', '迁都要玩家按 Y 才生效');
  assert.equal(cs[prompts[0]].owner, null);
});

test('F2-3 填满队伍：刷到上限后再跑一次刷新检查（T2）', () => {
  let n = 0;
  const world = { aiParties: [{}, {}], staleRemoved: 0,
    respawn() { if (this.aiParties.length >= 10) { this.staleRemoved++; this.aiParties.pop(); } this.aiParties.push({ id: ++n }); return this.aiParties.at(-1); } };
  const r = applyDevFillTeams(world, 10);
  assert.deepEqual({ ...r, removedNames: undefined }, { added: 8, total: 10, max: 10, removed: 1, removedNames: undefined, replaced: true });
  assert.equal(world.staleLog, null, '调试用的撤下记录用完就清掉');
});

test('QA-19：F2→3 提示写明撤了谁、补刷了没有；没撤时说明条件', () => {
  assert.match(fillTeamsText({ total: 10, max: 10, added: 0, removed: 1, removedNames: ['黄巾小队（战力 12）'], replaced: true }), /撤下过弱黄巾 1 支：黄巾小队（战力 12），已补刷 1 支/);
  assert.match(fillTeamsText({ total: 10, max: 10, added: 3, removed: 0, removedNames: [], replaced: false }), /补满新刷 3.*T2 未触发：没有符合条件/);
});

test('QA-18：F2→2 临时放出的大本营，选 N 还给原势力（名将军不被挤出）；选 Y 归玩家', () => {
  const src = readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8');
  assert.match(src, /devFreedOwner[\s\S]{0,200}else if \(freed\) c\.owner = freed/);
  const cs = createCities(balance), prompts = [];
  for (const c of Object.values(cs)) if (c.owner == null && c.id !== 'luoyang') c.owner = 'wei';
  cs.luoyang.owner = PLAYER;
  const world = { state: { cities: cs, homeCity: 'luoyang' }, player: { x: cs.luoyang.x, y: cs.luoyang.y }, aiParties: [], onCaptureReady(c) { prompts.push(c.id); } };
  const msg = applyDevHomeCity(world), c = cs[prompts[0]];
  assert.match(msg, /大本营临时设为无主/);
  assert.equal(c.owner, null); assert.equal(c.devFreedOwner, 'wei');
});

test('F2 调试菜单只在开发模式加载（UIScene 里 import.meta.env.DEV 下动态 import），正式构建里不存在', () => {
  const ui = readFileSync(new URL('../src/scenes/UIScene.js', import.meta.url), 'utf8');
  assert.match(ui, /if \(import\.meta\.env\.DEV\) \{[^\n]*\n\s*import\('\.\.\/ui\/DebugMenu\.js'\)/);
  for (const f of ['src/scenes/UIScene.js', 'src/scenes/WorldScene.js', 'src/main.js'])
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /^import .*(DebugMenu|devTools)/m, `${f} 不静态 import 调试模块`);
});

test('QA-18（a7d1348 复测）：迁都弹窗没答就存档 → 存档里没有 devFreedOwner，城还给原势力；游戏里的状态不变', async () => {
  const { saveableState } = await import('../src/systems/world.js');
  const cs = createCities(balance), prompts = [];
  for (const c of Object.values(cs)) if (c.owner == null && c.id !== 'luoyang') c.owner = 'wei';
  cs.luoyang.owner = PLAYER;
  const state = { cities: cs, homeCity: 'luoyang', points: 3 };
  applyDevHomeCity({ state, player: { x: cs.luoyang.x, y: cs.luoyang.y }, aiParties: [], onCaptureReady(c) { prompts.push(c.id); } });
  const id = prompts[0], saved = saveableState(state);
  assert.equal(JSON.stringify(saved).includes('devFreedOwner'), false);
  assert.equal(saved.cities[id].owner, 'wei');
  assert.equal(cs[id].owner, null); assert.equal(cs[id].devFreedOwner, 'wei', '弹窗还在等 Y / N');
  const src = readFileSync(new URL('../src/systems/world.js', import.meta.url), 'utf8');
  assert.match(src, /state: saveableState\(s\.state\)/);
});

// PM 2026-10-23：F2→4 给武将、F2→5 下一抽必出武将卡、F2→6 城防归零；大地图 E 没副将时提示
import { devGiveGeneral, giveGeneralText, pickDevWallCity, devBreakWall, breakWallText } from '../src/systems/devTools.js';
import { createGameState } from '../src/systems/gameState.js';
import { mulberry32 } from '../src/systems/rng.js';
import { genOffer } from '../src/systems/gachaOffer.js';
import { replaceKeyHint, NO_GENERALS_TEXT, FIELD_SWAP_HINT, resolvePending } from '../src/systems/roster.js';
import { cityTick } from '../src/systems/city.js';
const mkTeam = () => ({ id: 'player', is_player: true, soldiers: 60, unit: 'inf', drill: 0, generals: [{ ...balance.hero }], items: [] });

test('F2-4 给武将：有空位直接入队（先 A 级），出自由池；满编进 pendingGenerals（走名册规则）；自由池空 → null', () => {
  const s = createGameState(balance), t = mkTeam(), max = balance.team_rules.max_generals;
  const pool0 = s.freePool.length;
  const r1 = devGiveGeneral(s, t, balance, 10);
  assert.ok(r1.joined && r1.general.tier === 'A' && t.generals.length === 2 && !s.freePool.includes(r1.general.id) && s.freePool.length === pool0 - 1);
  assert.match(giveGeneralText(r1), /作为副将加入/);
  while (t.generals.length < max) devGiveGeneral(s, t, balance);
  const r2 = devGiveGeneral(s, t, balance, 20);
  assert.equal(r2.joined, false); assert.equal(t.generals.length, max);
  assert.equal(s.pendingGenerals.length, 1); assert.equal(s.pendingGenerals[0].source, 'dev');
  assert.match(giveGeneralText(r2), /队伍已满/);
  // 名册规则照常：流放新来的 → 加 exile 点数
  const pts = s.points; resolvePending(s, t, 'exile', null, balance);
  assert.ok(s.pendingGenerals.length === 0 && s.points >= pts);
  s.freePool = [];
  assert.equal(devGiveGeneral(s, t, balance), null); assert.match(giveGeneralText(null), /没有可给的武将/);
});

test('F2-5 下一抽必出武将卡：forceGeneral → 有且只有 1 张武将卡、仍有成长卡、4 张；不传时结果和原来逐字节一样（不多掷随机数）', () => {
  const g = balance.v06.gacha;
  let forcedWithGen = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const s = createGameState(balance), t = mkTeam();
    const a = genOffer(s, t, balance, mulberry32(seed), { chapter: 0 });
    const b = genOffer(createGameState(balance), mkTeam(), balance, mulberry32(seed), { chapter: 0 });
    assert.deepEqual(a, b, '不传 forceGeneral：确定');
    const f = genOffer(createGameState(balance), mkTeam(), balance, mulberry32(seed), { chapter: 0, forceGeneral: true });
    const gens = f.cards.filter(c => c.kind.startsWith('general_')).length;
    assert.ok(gens >= 1 && gens <= g.max_general_cards, `seed ${seed}`);
    assert.ok(f.cards.some(c => g.growth_kinds.includes(c.kind)), `seed ${seed} 仍有成长卡`);
    assert.equal(f.cards.length, a.cards.length);
    if (!a.cards.some(c => c.kind.startsWith('general_'))) forcedWithGen++;
  }
  assert.ok(forcedWithGen > 0, '有原本没有武将卡的种子被补上');
  const s = createGameState(balance); s.freePool = [];
  const none = genOffer(s, mkTeam(), balance, mulberry32(1), { chapter: 0, forceGeneral: true });
  assert.ok(!none.cards.some(c => c.kind.startsWith('general_')), '自由池空：给不出武将卡就不换');
});

test('F2-6 城防归零：最近的非我方城 def = 0，记 zeroAtS / zeroAwayS / lastHitS，守军不动；之后按 regen_rule 离开满 break_window_s 才回复', () => {
  const cs = createCities(balance), L = cs.luoyang, C = balance.v06.city;
  assert.equal(pickDevWallCity(cs, { x: L.x + 5, y: L.y }), 'luoyang');
  const gar = cs.luoyang.garrison;
  const c = devBreakWall(cs, { x: L.x + 5, y: L.y }, 100);
  assert.ok(c.id === 'luoyang' && c.def === 0 && c.zeroAtS === 100 && c.zeroAwayS === 0 && c.lastHitS === 100);
  assert.deepEqual(cs.luoyang.garrison, gar, '守军不动');
  assert.match(breakWallText(c, balance), /城防 → 0\//);
  // 已破的城不再选（换下一座最近的未破城）
  assert.notEqual(pickDevWallCity(cs, { x: L.x + 5, y: L.y }), 'luoyang');
  // 没人贴城：break_window_s 内不回复，之后回复
  let t = 100;
  for (; t < 100 + C.break_window_s - 1; t += 0.5) cityTick(cs, [], { tS: t, dt: 0.5, chapter: 0, balance, move: {}, homeCity: null, hostile: () => false });
  assert.equal(cs.luoyang.def, 0, `${C.break_window_s} s 内不回复`);
  for (; t < 100 + C.break_window_s + Math.max(5, C.regen_idle_s) + 5; t += 0.5) cityTick(cs, [], { tS: t, dt: 0.5, chapter: 0, balance, move: {}, homeCity: null, hostile: () => false });
  assert.ok(cs.luoyang.def > 0, '窗口过后开始回复');
});

test('大地图按 E：没有副将 → 「还没有武将」；有副将 → 「调动副将要在主城里按 H」；UIScene 接了 REPLACE（弹窗开着时不管）', () => {
  const t = mkTeam();
  assert.equal(replaceKeyHint(t, balance), NO_GENERALS_TEXT); assert.equal(NO_GENERALS_TEXT, '还没有武将');
  t.generals.push({ id: 'x', name: 'x' });
  assert.equal(replaceKeyHint(t, balance), FIELD_SWAP_HINT); assert.equal(FIELD_SWAP_HINT, '调动副将要在主城里按 H');
  const ui = readFileSync(new URL('../src/scenes/UIScene.js', import.meta.url), 'utf8');
  assert.match(ui, /act\.on\(ACTIONS\.REPLACE, \(\) => \{ if \(this\.pauseUi \|\| this\.modalOpen\(\)\) return; const t = replaceKeyHint/);
});

test('F2 菜单 4 / 5 / 6 接线；GachaScene 只在开发构建传 forceGeneral，用一次就关', () => {
  const m = readFileSync(new URL('../src/ui/DebugMenu.js', import.meta.url), 'utf8');
  for (const s of ['4  给一名武将', '5  下一次抽卡必出武将卡（用一次自动关，菜单不关）', '6  最近的城城防归零']) assert.ok(m.includes(s), s);
  assert.match(m, /if \(r && !r\.joined\) this\.ui\.openRoster\(\)/);
  const g = readFileSync(new URL('../src/scenes/GachaScene.js', import.meta.url), 'utf8');
  assert.match(g, /\.\.\.\(import\.meta\.env\.DEV && this\.world\.devNextGeneral \? \{ forceGeneral: true \} : \{\}\)/);
  assert.match(g, /if \(import\.meta\.env\.DEV && ctx\.forceGeneral\) this\.world\.devNextGeneral = false;/);
});

test('F2-5 用一次自动关：只强制带 forceGeneral 的那一抽；同种子不强制时仍无武将（若原本没有）', () => {
  let found = false;
  for (let s = 1; s <= 80; s++) {
    const plain = genOffer(createGameState(balance), mkTeam(), balance, mulberry32(s), { chapter: 0 });
    if (plain.cards.some(c => c.kind.startsWith('general_'))) continue;
    const forced = genOffer(createGameState(balance), mkTeam(), balance, mulberry32(s), { chapter: 0, forceGeneral: true });
    const again = genOffer(createGameState(balance), mkTeam(), balance, mulberry32(s), { chapter: 0 }); // 模拟 flag 已清
    assert.ok(forced.cards.some(c => c.kind.startsWith('general_')), `seed ${s} 强制有武将`);
    assert.ok(!again.cards.some(c => c.kind.startsWith('general_')), `seed ${s} 不清强制则无`);
    assert.deepEqual(plain, again);
    found = true; break;
  }
  assert.ok(found, '找到原本没有武将卡的种子');
  const g = readFileSync(new URL('../src/scenes/GachaScene.js', import.meta.url), 'utf8');
  assert.match(g, /if \(import\.meta\.env\.DEV && ctx\.forceGeneral\) this\.world\.devNextGeneral = false;/);
});
