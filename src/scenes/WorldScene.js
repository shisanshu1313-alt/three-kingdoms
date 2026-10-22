import Phaser from 'phaser';
import {
  TILE_SIZE, CAMERA_LERP, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, MINIMAP_SIZE, NEAR_PLAYER_FULL_LABEL_PX
} from '../config.js';
import { generateMap, TERRAIN } from '../world/MapGenerator.js';
import Pathfinder from '../world/Pathfinder.js';
import Party from '../entities/Party.js';
import AISystem from '../systems/ai.js';
import CollisionSystem from '../systems/collision.js';
import BattleSystem from '../systems/battle.js';
import { createGameState, pushLog } from '../systems/gameState.js';
import { buildRespawnTeam } from '../systems/teams.js';
import { EventBus, EVENTS } from '../core/EventBus.js';
import { balance, assumptions, index, loadInitialTeams, factionColor, nextBanditName } from '../data/index.js';

export default class WorldScene extends Phaser.Scene {
  constructor() { super('World'); }

  create() {
    // ---- 地图 ----
    this.mapData = generateMap();
    const { width, height, grid, cities } = this.mapData;
    this.tileSize = TILE_SIZE;
    this.worldW = width * TILE_SIZE;
    this.worldH = height * TILE_SIZE;
    this.pathfinder = new Pathfinder(grid, TERRAIN);

    const map = this.make.tilemap({ data: grid, tileWidth: TILE_SIZE, tileHeight: TILE_SIZE });
    const tileset = map.addTilesetImage('tiles', 'tiles', TILE_SIZE, TILE_SIZE, 0, 0);
    this.layer = map.createLayer(0, tileset, 0, 0);

    this.cityLabels = cities.map(c => this.add.text(c.x * TILE_SIZE, (c.y - 2) * TILE_SIZE - 4, c.name, {
      fontFamily: 'sans-serif', fontSize: '18px', color: '#fff3c4', stroke: '#000', strokeThickness: 4
    }).setOrigin(0.5, 1).setDepth(5));

    // ---- 镜头 / 小地图（先建好，addParty 时要设置 ignore）----
    const cam = this.cameras.main;
    cam.setBounds(0, 0, this.worldW, this.worldH);
    this.minimap = this.cameras.add(0, 0, MINIMAP_SIZE, MINIMAP_SIZE).setName('minimap');
    this.minimap.setZoom(MINIMAP_SIZE / Math.max(this.worldW, this.worldH));
    this.minimap.setBounds(0, 0, this.worldW, this.worldH);
    this.minimap.centerOn(this.worldW / 2, this.worldH / 2);
    this.minimap.setBackgroundColor(0x000000);

    // ---- 状态与系统 ----
    this.state = createGameState(balance);
    this.parties = [];
    this.aiParties = [];
    this.spawnCounter = 0;
    const teams = loadInitialTeams();
    this.player = this.addParty(teams.player);
    teams.ai.forEach(t => this.addParty(t));
    this.collisions = new CollisionSystem();
    this.aiSystem = new AISystem(balance);
    this.battleSystem = new BattleSystem(this, balance, assumptions.battle, this.state);

    // 补充刷新（balance.spawn）：每 respawn_interval_s 检查一次，AI 队伍（含初始）不足 max_ai_teams 就刷一支
    this.time.addEvent({ delay: balance.spawn.respawn_interval_s * 1000, loop: true, callback: () => this.respawn() });

    // ---- 调试 ----
    this.debugVision = false;
    this.debugGfx = this.add.graphics().setDepth(8);
    this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F1).on('down', () => this.toggleVision());

    // ---- 输入 ----
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys('W,A,S,D');
    this.targetMarker = this.add.rectangle(0, 0, 10, 10).setStrokeStyle(2, 0xffffff).setVisible(false).setDepth(9);
    this.pointerWorld = { x: -1e9, y: -1e9 };

    this.input.on('pointerdown', (pointer) => {
      if (!pointer.leftButtonDown() || this.isOverMinimap(pointer)) return;
      const wp = cam.getWorldPoint(pointer.x, pointer.y);
      this.setPlayerTarget(wp.x, wp.y);
    });
    this.input.on('pointermove', (pointer) => {
      const wp = cam.getWorldPoint(pointer.x, pointer.y);
      this.pointerWorld = { x: wp.x, y: wp.y };
    });
    this.input.on('wheel', (_p, _o, _dx, dy) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom - Math.sign(dy) * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
    });

    cam.startFollow(this.player.body, true, CAMERA_LERP, CAMERA_LERP);
    this.minimap.ignore([...this.cityLabels, this.targetMarker, this.debugGfx]);
    this.positionMinimap();
    this.scale.on('resize', () => this.positionMinimap());

    this.scene.launch('UI');
  }

  // ================= 队伍管理 =================
  addParty(team) {
    const sp = this.findPassableNear(Math.floor(team.position.x / TILE_SIZE), Math.floor(team.position.y / TILE_SIZE));
    team.position = sp;
    if (!team.home) team.home = { ...sp };
    const p = new Party(this, team, balance, factionColor(team.faction));
    // 小地图标记（主相机不显示），否则 20px 色块缩到 1px 看不清
    p.minimapDot = this.add.rectangle(p.x, p.y, 64, 64, p.color).setStrokeStyle(p.isPlayer ? 16 : 0, 0xffffff).setDepth(20);
    this.cameras.main.ignore(p.minimapDot);
    this.minimap.ignore(p.label);
    this.parties.push(p);
    if (!p.isPlayer) this.aiParties.push(p);
    EventBus.emit(EVENTS.PARTY_SPAWNED, { party: p });
    return p;
  }

  removeParty(p) {
    this.parties = this.parties.filter(x => x !== p);
    this.aiParties = this.aiParties.filter(x => x !== p);
    p.destroy();
    EventBus.emit(EVENTS.PARTY_REMOVED, { party: p });
  }

  /** spawn.position_rule：距玩家 dist_from_player_px、可通行、不在玩家视野内；失败重试 10 次后跳过 */
  respawn() {
    const sp = balance.spawn;
    if (this.aiParties.length >= sp.max_ai_teams) return null;
    const [dmin, dmax] = sp.dist_from_player_px;
    let pos = null;
    for (let tries = 0; tries < 10 && !pos; tries++) {
      const ang = Math.random() * Math.PI * 2, d = dmin + Math.random() * (dmax - dmin);
      const x = this.player.x + Math.cos(ang) * d, y = this.player.y + Math.sin(ang) * d;
      if (x < 0 || y < 0 || x >= this.worldW || y >= this.worldH) continue;
      if (!this.isPassable(x, y)) continue;
      const c = { x: (Math.floor(x / TILE_SIZE) + 0.5) * TILE_SIZE, y: (Math.floor(y / TILE_SIZE) + 0.5) * TILE_SIZE };
      if (Math.hypot(c.x - this.player.x, c.y - this.player.y) <= balance.ai.vision_px) continue;
      if (!this.player._fits(c.x, c.y, this)) continue;
      pos = c;
    }
    if (!pos) { console.log('[spawn] 10 次未找到合法位置，跳过本次刷新'); return null; }
    const n = ++this.spawnCounter;
    const team = buildRespawnTeam({
      id: `spawn_${n}`, position: pos, playerPower: this.player.power,
      balance, rng: Math.random, idx: index, nextName: nextBanditName
    });
    const p = this.addParty(team);
    console.log(`[spawn] ${p.name} 兵${team.soldiers} 战${Math.round(p.power)} (目标 ${Math.round(team.targetPower)})`);
    return p;
  }

  // ================= 战斗回调（BattleSystem 调用）=================
  onBattleStart(battle) {
    const { a, b } = battle;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const ring = this.add.circle(mx, my, 26).setStrokeStyle(3, 0xff4444).setDepth(12);
    const icon = this.add.text(mx, my - 30, '⚔', { fontSize: '22px', color: '#ffdddd', stroke: '#000', strokeThickness: 4 })
      .setOrigin(0.5).setDepth(13);
    this.minimap.ignore([ring, icon]);
    const tween = this.tweens.add({ targets: [ring], scale: 1.4, alpha: 0.4, yoyo: true, repeat: -1, duration: 300 });
    battle.marker = { ring, icon, tween };
    EventBus.emit(EVENTS.BATTLE_START, { battle });
  }

  onBattleEnd(battle, outcome) {
    const { a, b } = battle;
    if (battle.marker) { battle.marker.tween.stop(); battle.marker.ring.destroy(); battle.marker.icon.destroy(); }
    const now = this.time.now;
    if (outcome.outcome === 'draw') this.pushApart(a, b, outcome.pushback_px);
    if (outcome.playerDefeat) {
      this.player.invincibleUntil = now + outcome.playerDefeat.invincible_s * 1000;
      this.player.clearPath();
    }
    for (const id of outcome.removeIds) {
      const p = this.parties.find(x => x.id === id);
      if (p) this.removeParty(p);
    }
    for (const p of [a, b]) if (this.parties.includes(p)) p.refresh();
    pushLog(this.state, outcome.text, now);
    EventBus.emit(EVENTS.BATTLE_END, { battle, outcome });
  }

  /** collision.draw_pushback：沿两队中心连线双方各向外推 dist；落点不可通行则取最近可通行格 */
  pushApart(a, b, dist) {
    let dx = a.x - b.x, dy = a.y - b.y;
    let len = Math.hypot(dx, dy);
    if (len < 1e-6) { dx = 1; dy = 0; len = 1; }
    dx /= len; dy /= len;
    for (const [p, s] of [[a, 1], [b, -1]]) {
      const nx = Phaser.Math.Clamp(p.x + dx * s * dist, 0, this.worldW - 1);
      const ny = Phaser.Math.Clamp(p.y + dy * s * dist, 0, this.worldH - 1);
      if (p._fits(nx, ny, this)) p.setPosition(nx, ny);
      else { const c = this.findPassableNear(Math.floor(nx / TILE_SIZE), Math.floor(ny / TILE_SIZE)); p.setPosition(c.x, c.y); }
    }
  }

  // ================= 寻路 =================
  /** 从 party 当前位置到 (x,y) 的世界坐标路点（A* + 拉直），找不到返回 null */
  pathTo(party, x, y) {
    const T = TILE_SIZE;
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

  setPlayerTarget(x, y) {
    const path = this.pathTo(this.player, x, y);
    this.player.setPath(path);
    if (path) {
      const end = path[path.length - 1];
      this.targetMarker.setPosition(end.x, end.y).setVisible(true);
    }
    return path;
  }

  // ================= 地形查询 =================
  tileAt(px, py) {
    const tx = Math.floor(px / TILE_SIZE), ty = Math.floor(py / TILE_SIZE);
    const row = this.mapData.grid[ty];
    if (!row || row[tx] === undefined) return null;
    return TERRAIN[row[tx]];
  }
  isPassable(px, py) { const t = this.tileAt(px, py); return !!t && t.passable; }
  speedAt(px, py) { const t = this.tileAt(px, py); return t ? t.speed : 0; }

  findPassableNear(tx, ty) {
    const p = this.pathfinder.nearestPassable(tx, ty);
    const t = p || { x: tx, y: ty };
    return { x: (t.x + 0.5) * TILE_SIZE, y: (t.y + 0.5) * TILE_SIZE };
  }

  // ================= 小地图 / 调试 =================
  positionMinimap() { this.minimap.setPosition(this.scale.width - MINIMAP_SIZE - 10, 10); }

  isOverMinimap(pointer) {
    const m = this.minimap;
    return pointer.x >= m.x && pointer.x <= m.x + m.width && pointer.y >= m.y && pointer.y <= m.y + m.height;
  }

  toggleVision(on = !this.debugVision) {
    this.debugVision = on;
    if (!on) this.debugGfx.clear();
    return on;
  }

  drawDebug() {
    const g = this.debugGfx.clear(), R = balance.ai.vision_px;
    const stateColor = { chase: 0xff3333, flee: 0x33ccff, return: 0xffffff, wander: 0xdddddd };
    for (const p of this.parties) {
      g.lineStyle(2, p.color, 0.9).strokeCircle(p.x, p.y, R);
      g.fillStyle(p.color, 0.06).fillCircle(p.x, p.y, R);
      if (!p.isPlayer && p.team.home) g.lineStyle(1, p.color, 0.35).strokeCircle(p.team.home.x, p.team.home.y, balance.ai.wander_radius_px);
      if (p.path) {
        g.lineStyle(2, p.isPlayer ? 0xffff66 : (stateColor[p.ai?.state] ?? 0xffffff), 0.9).beginPath().moveTo(p.x, p.y);
        for (const w of p.path) g.lineTo(w.x, w.y);
        g.strokePath();
      }
    }
  }

  /** 标签：玩家/鼠标悬停/靠近玩家显示完整信息，其余简略；互相重叠时向上堆叠 */
  layoutLabels() {
    const pw = this.pointerWorld, pl = this.player;
    const order = [...this.parties].sort((a, b) =>
      (b.isPlayer - a.isPlayer) || (Math.hypot(a.x - pl.x, a.y - pl.y) - Math.hypot(b.x - pl.x, b.y - pl.y)));
    const placed = [];
    for (const p of order) {
      const hovered = Math.abs(pw.x - p.x) < p.size && Math.abs(pw.y - p.y) < p.size;
      if (p.inBattle) {
        // during_battle：损兵数字在 T 秒内线性播放，结束时一次性写入结果
        const bt = p.inBattle, t = Math.min(1, (this.time.now - bt.startAt) / (bt.endAt - bt.startAt));
        p.setBattleLabel(Math.round(bt.startSoldiers[p.id] - bt.lossOf[p.id] * t));
      } else {
        p.setLabelMode(p.isPlayer || hovered || Math.hypot(p.x - pl.x, p.y - pl.y) < NEAR_PLAYER_FULL_LABEL_PX);
      }
      const w = p.label.width, h = p.label.height;
      let bottom = p.y - p.size / 2 - 2;
      for (let iter = 0; iter < 8; iter++) {
        const hit = placed.find(r => p.x - w / 2 < r.right && p.x + w / 2 > r.left && bottom - h < r.bottom && bottom > r.top);
        if (!hit) break;
        bottom = hit.top - 1;
      }
      p.label.setPosition(p.x, bottom);
      placed.push({ left: p.x - w / 2, right: p.x + w / 2, top: bottom - h, bottom });
      // 战斗中/无敌提示色
      p.label.setColor(p.inBattle ? '#ff8888' : (p.isInvincible(this.time.now) ? '#88ffff' : '#ffffff'));
    }
  }

  // ================= 主循环 =================
  update(time, delta) {
    const dt = Math.min(delta, 50) / 1000;
    const pl = this.player;

    // 玩家：战斗中冻结；键盘优先（会取消点击路径）
    if (!pl.inBattle) {
      const k = this.cursors, w = this.wasd;
      const dx = (k.right.isDown || w.D.isDown ? 1 : 0) - (k.left.isDown || w.A.isDown ? 1 : 0);
      const dy = (k.down.isDown || w.S.isDown ? 1 : 0) - (k.up.isDown || w.W.isDown ? 1 : 0);
      if (dx || dy) {
        pl.clearPath();
        const len = Math.hypot(dx, dy);
        pl.move(dx / len, dy / len, dt, this);
      } else if (pl.path) {
        pl.followPath(dt, this);
      }
    }
    this.targetMarker.setVisible(!!pl.path);

    this.aiSystem.update(this.aiParties, this.parties, dt, time, this);
    const overlaps = this.collisions.update(this.parties, time);
    this.battleSystem.update(overlaps, time);

    for (const p of this.parties) p.minimapDot.setPosition(p.x, p.y);
    this.layoutLabels();
    if (this.debugVision) this.drawDebug();
  }
}
