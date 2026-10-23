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
