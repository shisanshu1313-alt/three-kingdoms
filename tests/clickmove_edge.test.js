// QA-09：点地移动的终点贴着障碍时，停在最靠近点击点、色块放得下的位置，而不是退回格心（以前最多差半格 → 「停在目标旁边」）。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap, TERRAIN } from '../src/world/MapGenerator.js';
import { WorldModel } from '../src/systems/world.js';
import PartyModel from '../src/systems/party.js';
import GameClock from '../src/core/GameClock.js';
import { balance, loadInitialTeams, factionColor } from '../src/data/index.js';
import { TILE_SIZE as T } from '../src/config.js';

test('终点格边上是障碍：路径终点 = 格心→点击点 方向上最靠近点击点、能放下色块的点', () => {
  const world = new WorldModel({ mapData: generateMap(), terrain: TERRAIN, tileSize: T, clock: new GameClock(0) });
  const player = new PartyModel(world.placeTeam(loadInitialTeams().player), balance, factionColor('player'));
  // 找一个：玩家能走到、右边一格是障碍、格心放得下色块的格子，点它右边缘内 2 px
  const tx0 = Math.floor(player.x / T), ty0 = Math.floor(player.y / T);
  let found = null;
  for (let r = 1; r < 40 && !found; r++) for (let dx = -r; dx <= r && !found; dx++) for (const dy of [-r, r]) {
    const tx = tx0 + dx, ty = ty0 + dy, cx = (tx + 0.5) * T, cy = (ty + 0.5) * T;
    if (!world.isPassable(cx, cy) || world.isPassable(cx + T, cy) || !player._fits(cx, cy, world)) continue;
    const x = (tx + 1) * T - 2, y = cy;
    if (player._fits(x, y, world)) continue;
    const path = world.pathTo(player, x, y);
    if (path && !path.partial) { found = { path, x, y, cx, cy }; break; }
  }
  assert.ok(found, '地图上找得到贴障碍的格子');
  const end = found.path.at(-1);
  assert.ok(player._fits(end.x, end.y, world), '终点放得下色块');
  assert.ok(Math.hypot(end.x - found.x, end.y - found.y) < Math.hypot(found.cx - found.x, found.cy - found.y) - 1, `终点比格心更靠近点击点（终点 ${end.x.toFixed(1)},${end.y.toFixed(1)} 格心 ${found.cx},${found.cy} 点 ${found.x},${found.y}）`);
});

test('QA-12 / QA-13：标签夹在地图内；飘字放在标签上方（源码接线）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8');
  const m = /export const labelX = (.*);\n/.exec(src);
  assert.ok(m, 'labelX 存在');
  const labelX = eval(m[1]);
  assert.equal(labelX(3, 80, 1600), 42, '左边缘：标签左边不出地图');
  assert.equal(labelX(1599, 80, 1600), 1558, '右边缘');
  assert.equal(labelX(800, 80, 1600), 800, '中间不动');
  assert.match(src, /const lx = labelX\(v\.body\.x, w, this\.worldW\)/);
  assert.match(src, /lab \? Math\.min\(lab\.y - lab\.height/);
});
