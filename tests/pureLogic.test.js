import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 平台规则 1：游戏逻辑是纯 JS。systems/ core/ world/ data/ platform/ 下的所有模块必须能在纯 Node 里加载：
 * 不装 Phaser（import 'phaser' 直接报错）、没有 window / document。
 */
const SRC = new URL('../src/', import.meta.url);
const DIRS = ['systems', 'core', 'world', 'data', 'platform'];
const modules = ['config.js', ...DIRS.flatMap(d => readdirSync(new URL(d + '/', SRC)).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`))];

test('纯逻辑模块在纯 Node 里加载（无 Phaser / DOM）', () => {
  assert.ok(modules.length >= 20, `模块数 ${modules.length}`);
  const urls = modules.map(m => new URL(m, SRC).href);
  const script = `
    if (typeof window !== 'undefined' || typeof document !== 'undefined') throw new Error('有 DOM');
    const urls = ${JSON.stringify(urls)};
    const out = {};
    for (const u of urls) { const m = await import(u); out[u.split('/src/')[1]] = Object.keys(m).length; }
    if (typeof window !== 'undefined' || typeof document !== 'undefined') throw new Error('模块创建了 DOM 全局');
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./helpers/no-phaser.mjs', import.meta.url)), '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const loaded = JSON.parse(r.stdout.trim().split('\n').pop());
  for (const m of modules) assert.ok(m in loaded, `${m} 未加载`);
});

test('钩子确实会拦截 phaser', () => {
  const r = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./helpers/no-phaser.mjs', import.meta.url)), '--input-type=module', '-e', "await import('phaser')"], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /禁止/);
});

test('纯逻辑模拟：PartyModel + WorldModel + AI / 碰撞 / 战斗系统 不依赖场景就能跑', async () => {
  const { generateMap, TERRAIN } = await import('../src/world/MapGenerator.js');
  const { WorldModel, snapshotWorld } = await import('../src/systems/world.js');
  const { default: PartyModel } = await import('../src/systems/party.js');
  const { default: AISystem } = await import('../src/systems/ai.js');
  const { default: CollisionSystem } = await import('../src/systems/collision.js');
  const { default: BattleSystem } = await import('../src/systems/battle.js');
  const { default: GameClock } = await import('../src/core/GameClock.js');
  const { mulberry32 } = await import('../src/systems/rng.js');
  const { createGameState } = await import('../src/systems/gameState.js');
  const { balance, loadInitialTeams, resetWorldRandom, teamRng, factionColor, nextBanditName } = await import('../src/data/index.js');
  const { TILE_SIZE } = await import('../src/config.js');
  const { parseSave, makeSave } = await import('../src/systems/save.js');

  resetWorldRandom();
  const clock = new GameClock(0);
  const world = new WorldModel({ mapData: generateMap(), terrain: TERRAIN, tileSize: TILE_SIZE, clock });
  const teams = loadInitialTeams();
  const mk = t => new PartyModel(world.placeTeam(t), balance, factionColor(t.faction));
  const player = mk(teams.player), ai = teams.ai.map(mk), all = [player, ...ai];
  const state = createGameState(balance);
  const events = [];
  const hooks = { beforeBattleStart() { events.push('save'); }, onBattleStart(b) { events.push('start'); }, onBattleEnd(b, o) { events.push('end'); } };
  const rngs = { team: teamRng, gacha: mulberry32(1), combat: mulberry32(2) };
  const aiSys = new AISystem(balance, mulberry32(3)), col = new CollisionSystem(), bat = new BattleSystem(hooks, balance, state, rngs.combat);

  // 点击寻路：玩家走到 5 格外的一个可达点
  const target = world.findPassableNear(Math.floor(player.x / TILE_SIZE) + 5, Math.floor(player.y / TILE_SIZE));
  assert.ok(world.clickMove(player, target.x, target.y));
  const x0 = player.x;
  for (let i = 0; i < 600; i++) {
    clock.tick(50);
    if (!player.inBattle) player.followPath(0.05, world);
    aiSys.update(ai, all, 0.05, clock.now, world);
    bat.update(col.update(all, clock.now), clock.now);
  }
  assert.notEqual(player.x, x0);
  assert.ok(ai.some(p => p.ai && p.ai.state), 'AI 有状态');
  // 补充刷新落点、平局推开都是纯函数
  const pos = world.respawnPosition(player, balance, mulberry32(9));
  if (pos) assert.ok(world.isPassable(pos.x, pos.y) && Math.hypot(pos.x - player.x, pos.y - player.y) > balance.ai.vision_px);
  const a = ai[0], b = ai[1]; b.setPosition(a.x, a.y);
  world.pushApart(a, b, balance.collision.draw_pushback_px ?? 40);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 1 && a._fits(a.x, a.y, world) && b._fits(b.x, b.y, world));
  // 快照 → 存档 → 读档
  const snap = snapshotWorld({ clock, state, player, aiParties: ai, spawnCounter: 0, names: nextBanditName.getState(), rngs, battleSystem: bat, cameraZoom: 1, balance });
  const { mapSeed } = await import('../src/config.js').then(m => ({ mapSeed: m.MAP_SEED }));
  const save = makeSave(snap, { balance, mapSeed, reason: 'test' });
  const r = parseSave(JSON.stringify(save), { balance, mapSeed });
  assert.equal(r.save.player.team.position.x, player.x);
});
