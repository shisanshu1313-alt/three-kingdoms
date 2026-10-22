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

test('纯逻辑模拟：PartyModel + WorldModel + AI + v0.5 实时战斗（FieldBattle / melee.step）不依赖场景就能跑', async () => {
  const { generateMap, TERRAIN } = await import('../src/world/MapGenerator.js');
  const { WorldModel, snapshotWorld } = await import('../src/systems/world.js');
  const { default: PartyModel } = await import('../src/systems/party.js');
  const { default: AISystem } = await import('../src/systems/ai.js');
  const { default: FieldBattle } = await import('../src/systems/fieldBattle.js');
  const { assignUnit } = await import('../src/systems/units.js');
  const { default: GameClock } = await import('../src/core/GameClock.js');
  const { mulberry32 } = await import('../src/systems/rng.js');
  const { createGameState } = await import('../src/systems/gameState.js');
  const { balance, loadInitialTeams, resetWorldRandom, teamRng, factionColor, nextBanditName } = await import('../src/data/index.js');
  const { TILE_SIZE, MAP_SEED } = await import('../src/config.js');
  const { parseSave, makeSave } = await import('../src/systems/save.js');
  const { readFileSync } = await import('node:fs');
  const combatJson = JSON.parse(readFileSync(new URL('../src/data/combat_v05.json', import.meta.url)));

  /** 和 WorldScene.fixedTick 同样的循环（无 Phaser）；返回结果摘要，用来检查确定性 */
  const sim = (seed, ticks = 400) => {
    resetWorldRandom();
    const clock = new GameClock(0);
    const world = new WorldModel({ mapData: generateMap(), terrain: TERRAIN, tileSize: TILE_SIZE, clock });
    const teams = loadInitialTeams();
    const urng = mulberry32(seed ^ 0x5eed);
    const state = createGameState(balance);
    const rngs = { team: teamRng, gacha: mulberry32(1), combat: mulberry32(seed) };
    const events = [];
    const field = new FieldBattle({ combatJson, balance, gameState: state, rng: rngs.combat, seed,
      hooks: { onEngage: () => events.push('engage'), onEscape: () => events.push('escape'), onBattleEnd: () => events.push('end'), onCombatEnd: () => events.push('combat-end') } });
    const mk = t => { const p = new PartyModel(world.placeTeam(assignUnit(t, combatJson, urng)), balance, factionColor(t.faction)); field.add(p); return p; };
    const player = mk(teams.player), ai = teams.ai.map(mk), all = [player, ...ai];
    const aiSys = new AISystem(balance, mulberry32(seed + 3));
    const env = { fits: (b, x, y) => player._fits(x, y, world), speedMult: (x, y) => world.speedAt(x, y), hostile: (a, b) => a.faction !== b.faction };
    // 点击寻路：玩家走到 5 格外的一个可达点；再把一支 AI 放到玩家身边保证打起来
    const target = world.findPassableNear(Math.floor(player.x / TILE_SIZE) + 5, Math.floor(player.y / TILE_SIZE));
    assert.ok(world.clickMove(player, target.x, target.y));
    const foe = ai.find(p => p.faction === 'bandit');
    const x0 = player.x;
    for (let i = 0; i < ticks; i++) {
      clock.tick(100);
      if (i === 30) field.teleport(foe, player.x + 40, player.y);
      if (player.path) player.followPath(0.1, world);
      aiSys.update(ai, all, 0.1, clock.now, world);
      field.tick(0.1, env, clock.now);
    }
    return { clock, world, state, player, ai, rngs, field, x0, events,
      summary: { events, state: { points: state.points, battles: state.battleLog.length }, pos: all.filter(p => field.body(p.id)).map(p => [p.id, +p.x.toFixed(4), +p.y.toFixed(4), p.team.soldiers]) } };
  };
  const r1 = sim(11);
  const { clock, world, state, player, ai, rngs, field, x0 } = r1;
  assert.notEqual(player.x, x0);
  assert.ok(ai.some(p => p.ai && p.ai.state), 'AI 有状态');
  assert.ok(r1.events.includes('engage'), '发生了接触战斗');
  // 确定性：同种子同结果
  assert.deepEqual(sim(11).summary, r1.summary);
  // 补充刷新落点是纯函数
  const pos = world.respawnPosition(player, balance, mulberry32(9));
  if (pos) assert.ok(world.isPassable(pos.x, pos.y) && Math.hypot(pos.x - player.x, pos.y - player.y) > balance.ai.vision_px);
  // 快照（含战斗快照）→ 存档 → 读档
  const snap = snapshotWorld({ clock, state, player, aiParties: ai.filter(p => field.body(p.id)), spawnCounter: 0, names: nextBanditName.getState(), rngs, combat: field.serialize(), cameraZoom: 1, balance,
    run: (await import('../src/systems/run.js')).createRun({ runId: 'r1', runSeed: 11, cfg: (await import('../src/data/run_v05.json', { with: { type: 'json' } })).default }) });
  const save = makeSave(snap, { balance, mapSeed: MAP_SEED, reason: 'test' });
  const r = parseSave(JSON.stringify(save), { balance, mapSeed: MAP_SEED });
  assert.equal(r.save.player.team.position.x, player.x);
  assert.deepEqual(r.save.combat.state.bodies[player.id].x, field.body(player.id).x);
});
