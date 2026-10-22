import { test } from 'node:test';
import assert from 'node:assert/strict';
import Pathfinder from '../src/world/Pathfinder.js';

// 0=平原(1.0) 1=森林(0.5) 2=山(不可通行) 4=官道(1.25)
const TER = [{ id: 0, speed: 1, passable: true }, { id: 1, speed: 0.5, passable: true }, { id: 2, speed: 0, passable: false },
  { id: 3, speed: 0, passable: false }, { id: 4, speed: 1.25, passable: true }];
const parse = rows => rows.map(r => [...r].map(c => ({ '.': 0, f: 1, '#': 2, r: 4 }[c])));
const valid = (pf, path) => {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y;
    assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy), 'step must be 8-neighbour');
    assert.ok(pf.passable(b.x, b.y), `impassable ${b.x},${b.y}`);
    if (dx && dy) assert.ok(pf.passable(a.x + dx, a.y) && pf.passable(a.x, a.y + dy), `corner cut at ${a.x},${a.y}`);
  }
};

test('直线开阔地：对角+直走，长度最短', () => {
  const pf = new Pathfinder(parse(['.....', '.....', '.....', '.....', '.....']), TER);
  const p = pf.findPath(0, 0, 4, 2);
  valid(pf, p);
  assert.equal(p.length, 5); // 2 斜 + 2 直
  assert.deepEqual(p[p.length - 1], { x: 4, y: 2 });
});

test('绕过墙', () => {
  const pf = new Pathfinder(parse([
    '.....',
    '.###.',
    '.#...',
    '.#.#.',
    '...#.']), TER);
  const p = pf.findPath(2, 2, 0, 0);
  valid(pf, p);
  assert.deepEqual(p[0], { x: 2, y: 2 });
  assert.deepEqual(p[p.length - 1], { x: 0, y: 0 });
});

test('禁止切角：两墙对角缝隙不能斜穿', () => {
  const pf = new Pathfinder(parse([
    '.#',
    '#.']), TER);
  assert.equal(pf.findPath(0, 0, 1, 1).partial, true); // 不可达 → 部分路径
});

test('不可达 → 返回 partial 路径；终点在墙内 → 改到最近可通行格', () => {
  const pf = new Pathfinder(parse([
    '..#..',
    '..#..',
    '..#..']), TER);
  const p = pf.findPath(0, 1, 4, 1);
  assert.equal(p.partial, true);
  const q = pf.findPath(0, 0, 2, 1); // 终点是山
  valid(pf, q);
  assert.ok(pf.passable(q[q.length - 1].x, q[q.length - 1].y));
});

test('地形代价：宁可绕官道也不穿森林', () => {
  const pf = new Pathfinder(parse([
    'rrrrrrr',
    '.fffff.',
    '.fffff.']), TER);
  const p = pf.findPath(0, 2, 6, 2);
  valid(pf, p);
  assert.ok(!p.some(c => c.y === 2 && c.x > 0 && c.x < 6), '不应穿过森林');
  const direct = [0, 1, 2, 3, 4, 5, 6].map(x => ({ x, y: 2 }));
  assert.ok(pf.pathCost(p) < pf.pathCost(direct));
});

test('缓存命中 & 100x100 性能', () => {
  const N = 100, grid = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => (x === 50 && y < 95 ? 2 : (x * 7 + y * 13) % 11 === 0 ? 1 : 0)));
  const pf = new Pathfinder(grid, TER);
  const t0 = performance.now();
  const p = pf.findPath(2, 2, 97, 2);
  const ms = performance.now() - t0;
  valid(pf, p);
  assert.ok(!p.partial);
  assert.ok(p.some(c => c.x === 50 && c.y >= 95), '必须从墙底绕过');
  assert.ok(ms < 100, `too slow: ${ms}ms`);
  pf.findPath(2, 2, 97, 2);
  assert.equal(pf.stats.cacheHits, 1);
});
