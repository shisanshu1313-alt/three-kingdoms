import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateMap, TERRAIN } from '../src/world/MapGenerator.js';
import { WorldModel } from '../src/systems/world.js';
import PartyModel from '../src/systems/party.js';
import AISystem from '../src/systems/ai.js';
import FieldBattle from '../src/systems/fieldBattle.js';
import { assignUnit } from '../src/systems/units.js';
import GameClock from '../src/core/GameClock.js';
import { mulberry32, streamSeed } from '../src/systems/rng.js';
import { createGameState } from '../src/systems/gameState.js';
import { balance, loadInitialTeams, resetWorldRandom, teamRng, factionColor } from '../src/data/index.js';
import { TILE_SIZE } from '../src/config.js';
import { MIGRATIONS, SAVE_VERSION, migrate, validateSave } from '../src/systems/save.js';

/**
 * v0.6 确定性：同一 runSeed → 同一结果。所有游戏随机数都走种子流（team / gacha / combat / spawn / ai），
 * 逻辑只由固定 0.1 s tick 推进；Math.random 在模拟期间被替换成抛错，任何漏网的调用都会让测试失败。
 */
const combatJson = JSON.parse(readFileSync(new URL('../src/data/combat_v05.json', import.meta.url)));

function withNoMathRandom(fn) {
  const orig = Math.random;
  Math.random = () => { throw new Error('游戏逻辑调用了 Math.random（应走种子流）'); };
  try { return fn(); } finally { Math.random = orig; }
}

/** 与 WorldScene.fixedTick 相同的纯逻辑循环（无 Phaser）。restoreAt：在第 n tick 把 AI 流存出来、换一个新流再 setState（模拟存读档） */
function sim(runSeed, { ticks = 900, restoreAt = -1 } = {}) {
  return withNoMathRandom(() => {
    resetWorldRandom();
    const clock = new GameClock(0);
    const world = new WorldModel({ mapData: generateMap(), terrain: TERRAIN, tileSize: TILE_SIZE, clock });
    const teams = loadInitialTeams();
    const rngs = { combat: mulberry32(streamSeed(runSeed, 'combat')), ai: mulberry32(streamSeed(runSeed, 'ai')), unit: mulberry32(streamSeed(runSeed, 'unit')) };
    const state = createGameState(balance);
    const events = [];
    const field = new FieldBattle({ combatJson, balance, gameState: state, rng: rngs.combat, seed: runSeed,
      hooks: { onEngage: (a, b) => events.push(['engage', clock.now]), onEscape: () => events.push(['escape', clock.now]), onBattleEnd: () => events.push(['end', clock.now]) } });
    const mk = t => { const p = new PartyModel(world.placeTeam(assignUnit(t, combatJson, rngs.unit)), balance, factionColor(t.faction)); field.add(p); return p; };
    const player = mk(teams.player), ai = teams.ai.map(mk), all = [player, ...ai];
    const aiSys = new AISystem(balance, rngs.ai);
    const env = { fits: (b, x, y) => player._fits(x, y, world), speedMult: (x, y) => world.speedAt(x, y), hostile: (a, b) => a.faction !== b.faction };
    for (let i = 0; i < ticks; i++) {
      if (i === restoreAt) { const st = aiSys.rng.getState(); const fresh = mulberry32(1); fresh.setState(st); aiSys.rng = fresh; }
      clock.tick(100);
      aiSys.update(ai, all, 0.1, clock.now, world);
      field.tick(0.1, env, clock.now);
    }
    return JSON.stringify({ events, teamRng: teamRng.getState(), ai: aiSys.rng.getState(), combat: rngs.combat.getState(),
      parties: all.filter(p => field.body(p.id)).map(p => [p.id, p.x, p.y, p.team.soldiers, p.ai?.state ?? null]) });
  });
}

test('确定性：同一种子跑两遍（纯 Node，固定 tick，Math.random 禁用）结果逐字节相同；AI 确实在动', () => {
  const a = sim(7), b = sim(7);
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.ok(parsed.parties.some(p => p[4]), 'AI 有状态');
});

test('确定性：不同种子 → 结果不同（说明随机数确实来自 runSeed 派生的流）', () => {
  assert.notEqual(sim(7, { ticks: 300 }), sim(8, { ticks: 300 }));
});

test('确定性：中途把 AI 流存出来再还原（= 存读档）不改变结果', () => {
  assert.equal(sim(7, { restoreAt: 400 }), sim(7));
});

test('streamSeed：同一 runSeed 的不同流互不相同；稳定（写死值防止改坏后旧存档迁移结果变化）', () => {
  assert.notEqual(streamSeed(42, 'ai'), streamSeed(42, 'combat'));
  assert.notEqual(streamSeed(42, 'ai'), streamSeed(43, 'ai'));
  assert.equal(streamSeed(42, 'ai'), 1143273397);
  assert.ok(Number.isInteger(streamSeed(42, 'ai')) && streamSeed(42, 'ai') >= 0);
});

test('存档 v5 → v6：补 rng.ai = streamSeed(runSeed, "ai")；已有的不覆盖；不改原对象', () => {
  assert.equal(SAVE_VERSION, 6);
  const v5 = { saveVersion: 5, run: { runSeed: 42 }, rng: { team: 1, gacha: 2, combat: 3 } };
  const out = MIGRATIONS[5](v5);
  assert.equal(out.saveVersion, 6);
  assert.deepEqual(out.rng, { team: 1, gacha: 2, combat: 3, ai: streamSeed(42, 'ai') });
  assert.equal(v5.rng.ai, undefined);
  assert.equal(MIGRATIONS[5]({ ...v5, rng: { ...v5.rng, ai: 99 } }).rng.ai, 99);
  assert.equal(migrate(structuredClone(v5)).rng.ai, streamSeed(42, 'ai'));
});

test('存档 v6 校验：随机数流状态必须是非负整数', () => {
  const errs = s => validateSave(s, balance).filter(e => /随机数流/.test(e));
  assert.equal(errs({ saveVersion: 6, rng: { team: 1, gacha: 2, combat: 3, ai: 4 } }).length, 0);
  assert.equal(errs({ saveVersion: 6, rng: { team: 1, gacha: 2, combat: 3, ai: -1 } }).length, 1);
  assert.equal(errs({ saveVersion: 6, rng: { team: 1, gacha: 2, combat: 3, ai: 1.5 } }).length, 1);
});
