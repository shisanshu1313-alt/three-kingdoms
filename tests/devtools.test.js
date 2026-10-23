// F2 调试菜单（仅开发模式）用的工具：选城逻辑（纯函数）+ 填满队伍 / 给主城的流程（用假的 world）。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balance } from '../src/data/index.js';
import { createCities, PLAYER, capture } from '../src/systems/city.js';
import { pickDevHomeCity, applyDevHomeCity, applyDevFillTeams } from '../src/systems/devTools.js';

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
  assert.deepEqual(applyDevFillTeams(world, 10), { added: 8, total: 10, max: 10, removed: 1 });
});

test('F2 调试菜单只在开发模式加载（UIScene 里 import.meta.env.DEV 下动态 import），正式构建里不存在', () => {
  const ui = readFileSync(new URL('../src/scenes/UIScene.js', import.meta.url), 'utf8');
  assert.match(ui, /if \(import\.meta\.env\.DEV\) \{[^\n]*\n\s*import\('\.\.\/ui\/DebugMenu\.js'\)/);
  for (const f of ['src/scenes/UIScene.js', 'src/scenes/WorldScene.js', 'src/main.js'])
    assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /^import .*(DebugMenu|devTools)/m, `${f} 不静态 import 调试模块`);
});
