import { MAP_SEED } from '../config.js';
import terrainData from '../data/terrain.json' with { type: 'json' };
import { balance } from '../data/index.js';

/** 地形表：表现字段来自 terrain.json，speed/passable 来自 balance.terrain_speed（null = 不可通行） */
export function buildTerrain(types, terrainSpeed) {
  return types.map(t => {
    const v = terrainSpeed[t.key];
    if (v === undefined) throw new Error(`balance.terrain_speed 缺少 ${t.key}`);
    return { ...t, speed: v ?? 0, passable: v !== null };
  });
}
export const TERRAIN = buildTerrain(terrainData.types, balance.terrain_speed); // 按 id 索引
export const T = Object.fromEntries(TERRAIN.map(t => [t.key.toUpperCase(), t.id]));

// 简单可复现随机数（mulberry32）
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成地图：以平原为主，少量森林/山/水，城池之间连官道。
 * 返回 { width, height, grid: number[][], cities }
 */
export function generateMap(width = balance.map.tiles_w, height = balance.map.tiles_h, seed = MAP_SEED) {
  const rand = rng(seed);
  const grid = Array.from({ length: height }, () => new Array(width).fill(T.GRASS));
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height;

  // 斑块：随机游走填充
  const blob = (type, count, size) => {
    for (let i = 0; i < count; i++) {
      let x = Math.floor(rand() * width), y = Math.floor(rand() * height);
      for (let s = 0; s < size; s++) {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (inside(x + dx, y + dy) && rand() < 0.6) grid[y + dy][x + dx] = type;
        }
        x += Math.floor(rand() * 3) - 1;
        y += Math.floor(rand() * 3) - 1;
      }
    }
  };
  // 斑块数量按地图面积缩放（v0.5 1600 px 地图 = v0.4 的 1/4 面积）
  const k = balance.map.blob_scale ?? 1, n = c => Math.max(1, Math.round(c * k));
  blob(T.FOREST, n(14), 40);
  blob(T.MOUNTAIN, n(6), 25);
  blob(T.WATER, n(3), 30);

  // 地图边缘一圈山作为边界
  for (let x = 0; x < width; x++) { grid[0][x] = T.MOUNTAIN; grid[height - 1][x] = T.MOUNTAIN; }
  for (let y = 0; y < height; y++) { grid[y][0] = T.MOUNTAIN; grid[y][width - 1] = T.MOUNTAIN; }

  // 官道：城池按顺序 L 形连接（城池格坐标来自 balance.cities[].tile）
  const cities = balance.cities.map(c => ({ id: c.id, name: c.name, x: c.tile.x, y: c.tile.y }));
  const road = (x0, y0, x1, y1) => {
    let x = x0, y = y0;
    while (x !== x1) { if (inside(x, y)) grid[y][x] = T.ROAD; x += Math.sign(x1 - x); }
    while (y !== y1) { if (inside(x, y)) grid[y][x] = T.ROAD; y += Math.sign(y1 - y); }
  };
  const order = ['changan', 'luoyang', 'xuchang', 'jianye', 'chengdu', 'changan'];
  const byId = Object.fromEntries(cities.map(c => [c.id, c]));
  for (let i = 0; i < order.length - 1; i++) {
    const a = byId[order[i]], b = byId[order[i + 1]];
    if (a && b) road(a.x, a.y, b.x, b.y);
  }

  // 城池：4x4 色块（覆盖城池中心格），周围清出一圈平原
  for (const c of cities) {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const x = c.x + dx, y = c.y + dy;
      if (!inside(x, y)) continue;
      const isCity = dx >= -2 && dx <= 1 && dy >= -2 && dy <= 1;
      if (isCity) grid[y][x] = T.CITY;
      else if (!TERRAIN[grid[y][x]].passable) grid[y][x] = T.GRASS;
    }
  }

  return { width, height, grid, cities };
}
