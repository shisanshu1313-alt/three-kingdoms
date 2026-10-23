import Pathfinder from '../world/Pathfinder.js';
import { getLeader } from './leader.js';
import { memToSave } from './save.js';
import { streamSeed } from './rng.js';

/**
 * 大地图逻辑模型（纯 JS，不依赖 Phaser / DOM）：地形查询、寻路（点击寻路 / AI 用的 pathTo）、
 * 出生 / 补充刷新落点、平局推开、存档快照。WorldScene 只负责输入、画面和调用这些函数。
 *
 * AI / 战斗 / 队伍移动收到的 world 参数就是它：clock、tileSize、worldW、worldH、speedAt、isPassable、pathTo。
 */
export class WorldModel {
  /** mapData = generateMap() 的结果；terrain = TERRAIN 表；clock = GameClock */
  constructor({ mapData, terrain, tileSize, clock }) {
    this.mapData = mapData;
    this.terrain = terrain;
    this.tileSize = tileSize;
    this.clock = clock;
    this.worldW = mapData.width * tileSize;
    this.worldH = mapData.height * tileSize;
    this.pathfinder = new Pathfinder(mapData.grid, terrain);
  }

  // ---------- 地形查询 ----------
  tileAt(px, py) {
    const T = this.tileSize, tx = Math.floor(px / T), ty = Math.floor(py / T);
    const row = this.mapData.grid[ty];
    if (!row || row[tx] === undefined) return null;
    return this.terrain[row[tx]];
  }
  isPassable(px, py) { const t = this.tileAt(px, py); return !!t && t.passable; }
  speedAt(px, py) { const t = this.tileAt(px, py); return t ? t.speed : 0; }

  /** 离格子 (tx,ty) 最近的可通行格中心（世界坐标） */
  findPassableNear(tx, ty) {
    const p = this.pathfinder.nearestPassable(tx, ty);
    const t = p || { x: tx, y: ty };
    return { x: (t.x + 0.5) * this.tileSize, y: (t.y + 0.5) * this.tileSize };
  }

  /** 新队伍落点：opts.exact（读档）且可通行 → 原样；否则吸附到最近可通行格中心 */
  placeTeam(team, { exact = false } = {}) {
    const T = this.tileSize;
    const exactOk = exact && this.isPassable(team.position.x, team.position.y);
    const sp = exactOk ? { ...team.position } : this.findPassableNear(Math.floor(team.position.x / T), Math.floor(team.position.y / T));
    team.position = sp;
    if (!team.home) team.home = { ...sp };
    return team;
  }

  // ---------- 寻路（点击寻路 / AI） ----------
  /** 从 party 当前位置到 (x,y) 的世界坐标路点（A* + 拉直），找不到返回 null */
  pathTo(party, x, y) {
    const T = this.tileSize;
    const tiles = this.pathfinder.findPath(Math.floor(party.x / T), Math.floor(party.y / T), Math.floor(x / T), Math.floor(y / T));
    if (!tiles) return null;
    const pts = tiles.map(t => ({ x: (t.x + 0.5) * T, y: (t.y + 0.5) * T }));
    // 终点：目标点可站就用精确点
    const last = tiles[tiles.length - 1];
    if (!tiles.partial && Math.floor(x / T) === last.x && Math.floor(y / T) === last.y && party._fits(x, y, this)) {
      pts[pts.length - 1] = { x, y };
    }
    // 拉直：从当前位置贪心跳到最远的直线可达路点（向前最多看 10 个）
    const out = [];
    let from = { x: party.x, y: party.y }, i = 0;
    while (i < pts.length) {
      let j = Math.min(pts.length - 1, i + 10);
      while (j > i && !this.segmentClear(party, from, pts[j])) j--;
      if (j === i && !this.segmentClear(party, from, pts[i]) && i === 0) {
        // 起点偏离格心导致直线不通：先回到起始格中心
        out.push(pts[0]); from = pts[0]; i = 1; continue;
      }
      out.push(pts[j]); from = pts[j]; i = j + 1;
    }
    if (out.length && Math.hypot(out[0].x - party.x, out[0].y - party.y) < 2) out.shift();
    if (!out.length) return null;
    out.partial = !!tiles.partial;
    return out;
  }

  /** 队伍色块沿线段移动是否全程可站（每 8px 采样）。地形代价不同时只做可通行判断 */
  segmentClear(party, a, b) {
    const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.ceil(d / 8);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (!party._fits(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, this)) return false;
    }
    // 避免拉直穿过大片森林（代价高）：线段上若有比起点更慢的地形则不拉直
    const s0 = this.speedAt(a.x, a.y);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (this.speedAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < s0) return false;
    }
    return true;
  }

  /** 点击地面：给玩家设路径，返回路径（null = 到不了） */
  clickMove(player, x, y) {
    const path = this.pathTo(player, x, y);
    player.setPath(path);
    return path;
  }

  // ---------- 补充刷新落点（spawn.position_rule） ----------
  /**
   * 距玩家 dist_from_player_px、可通行、不在玩家视野内；失败重试 10 次后返回 null。
   * rng：落点随机数（必须传入种子流，WorldScene 用 rngs.spawn）
   */
  respawnPosition(player, balance, rng) {
    const T = this.tileSize, [dmin, dmax] = balance.spawn.dist_from_player_px;
    for (let tries = 0; tries < 10; tries++) {
      const ang = rng() * Math.PI * 2, d = dmin + rng() * (dmax - dmin);
      const x = player.x + Math.cos(ang) * d, y = player.y + Math.sin(ang) * d;
      if (x < 0 || y < 0 || x >= this.worldW || y >= this.worldH) continue;
      if (!this.isPassable(x, y)) continue;
      const c = { x: (Math.floor(x / T) + 0.5) * T, y: (Math.floor(y / T) + 0.5) * T };
      if (Math.hypot(c.x - player.x, c.y - player.y) <= balance.ai.vision_px) continue;
      if (!player._fits(c.x, c.y, this)) continue;
      return c;
    }
    return null;
  }

  // ---------- 平局推开（collision.draw_pushback） ----------
  /** 沿两队中心连线双方各向外推 dist；落点不可通行则取最近可通行格 */
  pushApart(a, b, dist) {
    const T = this.tileSize, clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    let dx = a.x - b.x, dy = a.y - b.y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-6) { dx = 1; dy = 0; len = 1; }
    dx /= len; dy /= len;
    for (const [p, s] of [[a, 1], [b, -1]]) {
      const nx = clamp(p.x + dx * s * dist, 0, this.worldW - 1);
      const ny = clamp(p.y + dy * s * dist, 0, this.worldH - 1);
      if (p._fits(nx, ny, this)) p.setPosition(nx, ny);
      else { const c = this.findPassableNear(Math.floor(nx / T), Math.floor(ny / T)); p.setPosition(c.x, c.y); }
    }
  }
}

/**
 * 纯数据快照（存档格式见 systems/save.js）。
 * s = { clock, state, player, aiParties, spawnCounter, names, rngs: {team, gacha, combat}, battleSystem?(v0.4), combat?(v0.5 快照), cameraZoom, balance }
 */
export function snapshotWorld(s) {
  const now = s.clock.now;
  const teamOf = p => { const t = structuredClone(p.team); t.position = { x: p.x, y: p.y }; return t; };
  const main = getLeader(s.player.team, s.balance); // v0.6 统帅（= 主角）
  return {
    gameTimeMs: now,
    state: structuredClone(s.state),
    player: { team: teamOf(s.player), mainGeneralId: main?.id ?? null,
      invincibleUntil: s.player.invincibleUntil ?? 0, graceUntil: s.player.graceUntil ?? 0 },
    ai: s.aiParties.map(p => ({ team: teamOf(p), mem: memToSave(p.ai, now), graceUntil: p.graceUntil ?? 0 })),
    spawn: { counter: s.spawnCounter },
    timers: s.clock.getState().timers,
    names: s.names,
    rng: { team: s.rngs.team.getState(), gacha: s.rngs.gacha.getState(), combat: s.rngs.combat.getState(), ...(s.rngs.spawn ? { spawn: s.rngs.spawn.getState() } : {}), ai: s.rngs.ai ? s.rngs.ai.getState() : streamSeed(s.run?.runSeed ?? 0, 'ai') }, // v6：没有 ai 流（测试 / 旧调用方）→ 新流的初始种子
    battles: s.battleSystem ? s.battleSystem.serialize() : [],
    pairCooldowns: s.battleSystem ? [...s.battleSystem.pairCooldown].filter(([, until]) => until > now) : [],
    combat: s.combat ?? null, // v0.5 实时战斗快照（melee state + AI 战术记忆），读档原样继续
    run: s.run ? structuredClone(s.run) : null, // v0.5 一局的状态（systems/run.js）
    camera: { zoom: s.cameraZoom }
  };
}
