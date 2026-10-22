/**
 * 网格 A* 寻路（纯 JS，无 Phaser 依赖；单测见 tests/pathfinder.test.js）
 * - 8 方向，禁止切角（斜走时两个相邻正交格都必须可通行）
 * - 代价 = 距离(1 或 √2) / 地形速度倍率（森林慢 → 代价高，官道快 → 代价低）
 * - 终点不可通行时自动改到最近的可通行格
 * - 小型 LRU 缓存 + 节点上限，避免大图卡顿
 */
const SQRT2 = Math.SQRT2;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node, f) {
    const a = this.a; a.push([f, node]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top[1];
  }
}

export default class Pathfinder {
  /**
   * @param grid  number[][] 地形 id
   * @param terrain  [{id, speed, passable}] 按 id 索引
   */
  constructor(grid, terrain, { maxNodes = 12000, cacheSize = 64 } = {}) {
    this.grid = grid; this.h = grid.length; this.w = grid[0].length;
    this.maxNodes = maxNodes; this.cacheSize = cacheSize;
    this.cost = new Float32Array(this.w * this.h); // 每格进入代价；Infinity = 不可通行
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const t = terrain[grid[y][x]];
      this.cost[y * this.w + x] = t && t.passable && t.speed > 0 ? 1 / t.speed : Infinity;
    }
    let minCost = Infinity; for (const c of this.cost) if (c < minCost) minCost = c;
    this.minCost = minCost === Infinity ? 1 : minCost; // 启发式需可采纳：用最低代价
    this.cache = new Map();
    this.stats = { searches: 0, cacheHits: 0, expanded: 0 };
  }

  passable(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h && this.cost[y * this.w + x] !== Infinity; }

  nearestPassable(x, y, maxR = 30) {
    x = Math.max(0, Math.min(this.w - 1, x)); y = Math.max(0, Math.min(this.h - 1, y));
    if (this.passable(x, y)) return { x, y };
    for (let r = 1; r <= maxR; r++) {
      let best = null, bd = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (this.passable(x + dx, y + dy)) { const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = { x: x + dx, y: y + dy }; } }
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * 求路径。返回格子数组 [{x,y}, ...]（含起点与终点），找不到返回 null。
   * 搜索超过 maxNodes 时返回到“离终点最近的已探索格”的部分路径（partial=true）。
   */
  findPath(sx, sy, gx, gy) {
    const start = this.nearestPassable(sx, sy, 3), goal = this.nearestPassable(gx, gy);
    if (!start || !goal) return null;
    const key = `${start.x},${start.y}>${goal.x},${goal.y}`;
    if (this.cache.has(key)) {
      this.stats.cacheHits++;
      const v = this.cache.get(key); this.cache.delete(key); this.cache.set(key, v); // LRU
      return v && v.map(p => ({ ...p }));
    }
    this.stats.searches++;
    const W = this.w, N = W * this.h;
    const g = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const s = start.y * W + start.x, t = goal.y * W + goal.x;
    const hfn = (i) => {
      const dx = Math.abs((i % W) - goal.x), dy = Math.abs(((i / W) | 0) - goal.y);
      return this.minCost * (dx + dy + (SQRT2 - 2) * Math.min(dx, dy)); // octile
    };
    const open = new MinHeap();
    g[s] = 0; open.push(s, hfn(s));
    let expanded = 0, bestI = s, bestH = hfn(s), found = false;
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === t) { found = true; break; }
      if (++expanded > this.maxNodes) break;
      const cx = cur % W, cy = (cur / W) | 0;
      const hc = hfn(cur); if (hc < bestH) { bestH = hc; bestI = cur; }
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!this.passable(nx, ny)) continue;
        if (dx && dy && (!this.passable(cx + dx, cy) || !this.passable(cx, cy + dy))) continue; // 禁止切角
        const ni = ny * W + nx;
        if (closed[ni]) continue;
        const ng = g[cur] + this.cost[ni] * (dx && dy ? SQRT2 : 1);
        if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; open.push(ni, ng + hfn(ni)); }
      }
    }
    this.stats.expanded += expanded;
    const end = found ? t : bestI;
    const path = [];
    for (let i = end; i !== -1; i = came[i]) path.push({ x: i % W, y: (i / W) | 0 });
    path.reverse();
    if (!path.length) return null;
    if (found) {
      this.cache.set(key, path);
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    }
    const out = path.map(p => ({ ...p }));
    if (!found) out.partial = true;
    return out;
  }

  /** 路径总代价（测试/调试用） */
  pathCost(path) {
    let c = 0;
    for (let i = 1; i < path.length; i++) {
      const d = path[i].x !== path[i - 1].x && path[i].y !== path[i - 1].y ? SQRT2 : 1;
      c += this.cost[path[i].y * this.w + path[i].x] * d;
    }
    return c;
  }
}
