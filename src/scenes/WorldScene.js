import { createSceneInput, ACTIONS } from '../platform/input.js';
import Phaser from 'phaser';
import {
  TILE_SIZE, CAMERA_LERP, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, MINIMAP_SIZE, NEAR_PLAYER_FULL_LABEL_PX, MAP_SEED, SAVE_INTERVAL_S
} from '../config.js';
import { generateMap, TERRAIN } from '../world/MapGenerator.js';
import PartyModel from '../systems/party.js';
import PartyView from '../entities/PartyView.js';
import { WorldModel, snapshotWorld } from '../systems/world.js';
import AISystem from '../systems/ai.js';
import CollisionSystem from '../systems/collision.js';
import BattleSystem from '../systems/battle.js';
import { createGameState, pushLog } from '../systems/gameState.js';
import { buildRespawnTeam } from '../systems/teams.js';
import { EventBus, EVENTS } from '../core/EventBus.js';
import { balance, index, loadInitialTeams, factionColor, nextBanditName, teamRng, resetWorldRandom } from '../data/index.js';
import { mulberry32 } from '../systems/rng.js';
import { makeSave, writeSave, memFromSave, restoreGameState } from '../systems/save.js';
import GameClock from '../core/GameClock.js';
import { getStorage } from '../platform/storage.js';
import { getLifecycle } from '../platform/lifecycle.js';

export default class WorldScene extends Phaser.Scene {
  constructor() { super('World'); }

  /** data.save：读档（已经过 parseSave 校验/迁移）；否则新游戏 */
  create(data = {}) {
    this.loadWarnings = data.warnings ?? [];
    try {
      this.build(data.save ?? null);
    } catch (e) {
      console.error('[save] 读档失败', e);
      if (!data.save) throw e;
      this.scene.start('Title', { error: `读档失败：${e.message}` });
    }
  }

  build(save) {
    // ---- 地图 ----
    // 逻辑模型（systems/world.js，纯 JS）：地形 / 寻路 / 落点；AI、战斗、队伍移动都只拿到它
    this.clock = new GameClock(save?.gameTimeMs ?? 0);
    this.model = new WorldModel({ mapData: generateMap(), terrain: TERRAIN, tileSize: TILE_SIZE, clock: this.clock });
    const { grid, cities } = this.mapData;

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

    // ---- 游戏时钟（v0.4 pause_scope）：所有计时都读 this.clock.now；只在本场景 update 里推进，场景暂停即冻结 ----
    this.parties = [];
    this.views = new Map(); // PartyModel → PartyView
    this.aiParties = [];
    this.collisions = new CollisionSystem();
    this.aiSystem = new AISystem(balance);
    if (save) {
      teamRng.setState(save.rng?.team ?? teamRng.getState());
      nextBanditName.setState(save.names);
      this.state = restoreGameState(save.state, createGameState(balance));
      this.spawnCounter = save.spawn.counter;
      this.player = this.addParty(structuredClone(save.player.team), { exact: true });
      this.player.invincibleUntil = save.player.invincibleUntil ?? 0;
      this.player.graceUntil = save.player.graceUntil ?? 0;
      for (const a of save.ai) {
        const p = this.addParty(structuredClone(a.team), { exact: true });
        p.ai = { ...memFromSave(a.mem), personality: this.aiSystem.personalityOf(p) };
        p.graceUntil = a.graceUntil ?? 0;
      }
    } else {
      resetWorldRandom(); // 同一页面里再开新游戏也从相同的种子开始
      this.state = createGameState(balance);
      this.spawnCounter = 0;
      const teams = loadInitialTeams();
      this.player = this.addParty(teams.player);
      teams.ai.forEach(t => this.addParty(t));
    }
    // 存档决定 3：抽卡与战斗结算用各自的种子随机数流，状态随存档保存（读档不能重掷）
    const newSeed = () => (Math.random() * 4294967296) >>> 0;
    this.rngs = { gacha: mulberry32(newSeed()), combat: mulberry32(newSeed()) };
    if (save?.rng?.gacha !== undefined) this.rngs.gacha.setState(save.rng.gacha);
    if (save?.rng?.combat !== undefined) this.rngs.combat.setState(save.rng.combat);
    this.battleSystem = new BattleSystem(this, balance, this.state, this.rngs.combat);
    if (save?.battles?.length) {
      const restored = this.battleSystem.restore(save.battles, new Map(this.parties.map(p => [p.id, p])));
      for (const bt of restored) this.onBattleStart(bt, { restored: true });
    }
    for (const [k, until] of save?.pairCooldowns ?? []) this.battleSystem.pairCooldown.set(k, until);

    // 补充刷新（balance.spawn）：每 respawn_interval_s（游戏时间）检查一次，AI 队伍（含初始）不足 max_ai_teams 就刷一支
    const T = save?.timers ?? {};
    this.clock.every('respawn', balance.spawn.respawn_interval_s * 1000, () => this.respawn(), T.respawn);

    // ---- 存档：定时（游戏时间）+ 事件后请求，战斗中/弹窗中延后；页面隐藏/关闭时能存就存 ----
    this.saveDirty = null;
    this.lastSaveAt = null;
    this.clock.every('autosave', SAVE_INTERVAL_S * 1000, () => this.requestSave('interval'), T.autosave);
    // 切后台 / 关闭：走平台生命周期接口（网页 = visibilitychange/pagehide/beforeunload；小游戏以后接 wx.onHide）
    const offHide = getLifecycle().onHide(() => this.trySaveNow('unload'));
    const onRosterResolved = () => this.requestSave('roster');
    const onModalClosed = (which) => this.requestSave(which === 'Gacha' ? 'gacha' : 'roster');
    this.game.events.on('roster-resolved', onRosterResolved);
    this.game.events.on('modal-closed', onModalClosed);
    this.events.once('shutdown', () => {
      offHide();
      this.game.events.off('roster-resolved', onRosterResolved);
      this.game.events.off('modal-closed', onModalClosed);
    });

    // ---- 调试 ----
    this.debugVision = false;
    this.debugGfx = this.add.graphics().setDepth(8);

    // ---- 输入 ----
    // 输入动作层（platform/input.js）：键盘 WASD/方向键 移动、左键点击寻路、滚轮缩放、F1 调试视野
    this.actions = createSceneInput(this, { move: true, capture: ['F1'] });
    this.actions.on(ACTIONS.DEBUG_VISION, ({ repeat }) => { if (!repeat) this.toggleVision(); }); // 与原 Key 'down' 一致：按住不重复切换
    this.targetMarker = this.add.rectangle(0, 0, 10, 10).setStrokeStyle(2, 0xffffff).setVisible(false).setDepth(9);
    this.pointerWorld = { x: -1e9, y: -1e9 };

    this.actions.on(ACTIONS.MOVE_TO, ({ x, y, pointer }) => {
      if (this.isOverMinimap(pointer) || this.scene.get('UI')?.hitsHud?.(pointer)) return;
      const wp = cam.getWorldPoint(x, y);
      this.setPlayerTarget(wp.x, wp.y);
    });
    this.actions.on(ACTIONS.POINTER_MOVE, ({ x, y }) => {
      const wp = cam.getWorldPoint(x, y);
      this.pointerWorld = { x: wp.x, y: wp.y };
    });
    this.actions.on(ACTIONS.ZOOM, ({ dy }) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom - Math.sign(dy) * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
    });

    if (save?.camera?.zoom) cam.setZoom(Phaser.Math.Clamp(save.camera.zoom, ZOOM_MIN, ZOOM_MAX));
    cam.startFollow(this.views.get(this.player).body, true, CAMERA_LERP, CAMERA_LERP);
    this.minimap.ignore([...this.cityLabels, this.targetMarker, this.debugGfx]);
    this.positionMinimap();
    this.scale.on('resize', () => this.positionMinimap());

    this.scene.launch('UI', { warnings: this.loadWarnings ?? [], loaded: !!save });
    this.loadWarnings = null;
  }

  // ================= 存档 =================
  /** 游戏时间（毫秒，读档后接着算；暂停时不走） */
  gameTime() { return this.clock.now; }

  /**
   * 存档决定 1：任何时刻都能存——进行中的战斗（结果开战时已掷好）、抽卡后未做的选择、待安排武将都在存档里，
   * 读档后原样继续 / 重新弹出选择窗口，不会回滚抽卡。
   */
  canSaveNow() {
    return !!(this.player && this.battleSystem);
  }

  /** BattleSystem 开战前回调：立即存档 */
  beforeBattleStart() { this.trySaveNow('battle-start'); }

  /** 纯数据快照（存档格式见 systems/save.js；逻辑在 systems/world.js） */
  snapshot() {
    return snapshotWorld({
      clock: this.clock, state: this.state, player: this.player, aiParties: this.aiParties, spawnCounter: this.spawnCounter,
      names: nextBanditName.getState(), rngs: { team: teamRng, ...this.rngs }, battleSystem: this.battleSystem,
      cameraZoom: this.cameras.main.zoom, balance
    });
  }

  /** 请求存档：能存就在下一帧存，否则等战斗/弹窗结束 */
  requestSave(reason = 'auto') {
    if (!this.saveDirty || reason === 'manual') this.saveDirty = reason;
  }

  /** 读档（F9）：已校验的存档 → 重启大地图场景 */
  loadFrom(save, warnings = []) {
    this.scene.stop('Gacha'); this.scene.stop('Roster');
    this.scene.restart({ save, warnings });
  }

  /** 立即尝试存档；不能存时返回 false（不会存半截状态） */
  trySaveNow(reason = 'auto') {
    if (!this.canSaveNow()) return false;
    const ok = writeSave(makeSave(this.snapshot(), { balance, mapSeed: MAP_SEED, reason }), getStorage());
    if (ok) {
      this.lastSaveAt = this.clock.now;
      console.log(`[save] ${reason} 存档完成`);
      this.game.events.emit('game-saved', { reason });
    }
    return ok;
  }


  // ================= 队伍管理 =================
  /** opts.exact：读档时位置可通行就原样使用（不吸附到格子中心） */
  addParty(team, opts = {}) {
    this.model.placeTeam(team, opts);
    const p = new PartyModel(team, balance, factionColor(team.faction));
    const v = new PartyView(this, p);
    this.views.set(p, v);
    this.cameras.main.ignore(v.minimapDot);
    this.minimap.ignore(v.label);
    this.parties.push(p);
    if (!p.isPlayer) this.aiParties.push(p);
    EventBus.emit(EVENTS.PARTY_SPAWNED, { party: p });
    return p;
  }

  removeParty(p) {
    this.parties = this.parties.filter(x => x !== p);
    this.aiParties = this.aiParties.filter(x => x !== p);
    this.views.get(p)?.destroy();
    this.views.delete(p);
    EventBus.emit(EVENTS.PARTY_REMOVED, { party: p });
  }

  /** 补充刷新：落点规则见 WorldModel.respawnPosition（spawn.position_rule） */
  respawn() {
    if (this.aiParties.length >= balance.spawn.max_ai_teams) return null;
    const pos = this.model.respawnPosition(this.player, balance, Math.random);
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
  /** opts.restored：读档恢复的进行中战斗，只画标记，不再发开战事件 */
  onBattleStart(battle, opts = {}) {
    const { a, b } = battle;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const ring = this.add.circle(mx, my, 26).setStrokeStyle(3, 0xff4444).setDepth(12);
    const icon = this.add.text(mx, my - 30, '⚔', { fontSize: '22px', color: '#ffdddd', stroke: '#000', strokeThickness: 4 })
      .setOrigin(0.5).setDepth(13);
    this.minimap.ignore([ring, icon]);
    const tween = this.tweens.add({ targets: [ring], scale: 1.4, alpha: 0.4, yoyo: true, repeat: -1, duration: 300 });
    battle.marker = { ring, icon, tween };
    if (!opts.restored) EventBus.emit(EVENTS.BATTLE_START, { battle });
  }

  onBattleEnd(battle, outcome) {
    const { a, b } = battle;
    if (battle.marker) { battle.marker.tween.stop(); battle.marker.ring.destroy(); battle.marker.icon.destroy(); }
    const now = this.clock.now;
    if (outcome.outcome === 'draw') this.model.pushApart(a, b, outcome.pushback_px);
    if (outcome.playerDefeat) {
      this.player.invincibleUntil = now + outcome.playerDefeat.invincible_s * 1000;
      this.player.clearPath();
    }
    for (const id of outcome.removeIds) {
      const p = this.parties.find(x => x.id === id);
      if (p) this.removeParty(p);
    }
    for (const p of [a, b]) if (this.parties.includes(p)) p.refresh();
    pushLog(this.state, outcome.text, this.gameTime());
    EventBus.emit(EVENTS.BATTLE_END, { battle, outcome });
    this.requestSave('battle');
  }

  setPlayerTarget(x, y) {
    const path = this.model.clickMove(this.player, x, y);
    if (path) {
      const end = path[path.length - 1];
      this.targetMarker.setPosition(end.x, end.y).setVisible(true);
    }
    return path;
  }

  // ================= 逻辑模型的快捷方式（UI / 调试 / 冒烟测试用） =================
  get mapData() { return this.model.mapData; }
  get pathfinder() { return this.model.pathfinder; }
  get tileSize() { return this.model.tileSize; }
  get worldW() { return this.model.worldW; }
  get worldH() { return this.model.worldH; }
  pathTo(party, x, y) { return this.model.pathTo(party, x, y); }
  tileAt(px, py) { return this.model.tileAt(px, py); }
  isPassable(px, py) { return this.model.isPassable(px, py); }
  speedAt(px, py) { return this.model.speedAt(px, py); }
  findPassableNear(tx, ty) { return this.model.findPassableNear(tx, ty); }

  // ================= 小地图 / 调试 =================
  positionMinimap() { this.minimap.setPosition(this.scale.width - MINIMAP_SIZE - 10, 10); }

  /** 调试 / 冒烟测试用：直接加点数（只在开发模式存在，F2 调用；生产构建里返回 null） */
  debugGrantPoints(n) {
    if (!import.meta.env.DEV) return null;
    this.state.points += n;
    pushLog(this.state, `【调试】点数 +${n}`, this.gameTime());
    return this.state.points;
  }

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
      const v = this.views.get(p);
      const hovered = Math.abs(pw.x - p.x) < p.size && Math.abs(pw.y - p.y) < p.size;
      if (p.inBattle) {
        // during_battle：损兵数字在 T 秒内线性播放，结束时一次性写入结果
        const bt = p.inBattle, t = Math.min(1, (this.clock.now - bt.startAt) / (bt.endAt - bt.startAt));
        v.setBattleLabel(Math.round(bt.startSoldiers[p.id] - bt.lossOf[p.id] * t));
      } else {
        v.setLabelMode(p.isPlayer || hovered || Math.hypot(p.x - pl.x, p.y - pl.y) < NEAR_PLAYER_FULL_LABEL_PX);
      }
      const w = v.label.width, h = v.label.height;
      let bottom = p.y - p.size / 2 - 2;
      for (let iter = 0; iter < 8; iter++) {
        const hit = placed.find(r => p.x - w / 2 < r.right && p.x + w / 2 > r.left && bottom - h < r.bottom && bottom > r.top);
        if (!hit) break;
        bottom = hit.top - 1;
      }
      v.label.setPosition(p.x, bottom);
      placed.push({ left: p.x - w / 2, right: p.x + w / 2, top: bottom - h, bottom });
      // 战斗中/无敌提示色
      v.label.setColor(p.inBattle ? '#ff8888' : (p.isInvincible(this.clock.now) ? '#88ffff' : '#ffffff'));
    }
  }

  // ================= 主循环 =================
  update(_time, delta) {
    // 游戏时钟：用帧间隔推进（单帧最多 250ms，切后台回来不会一下跳过很多）；本场景暂停时 update 不执行 → 时钟冻结
    this.clock.tick(Math.min(delta, 250));
    const time = this.clock.now;
    const dt = Math.min(delta, 50) / 1000;
    const pl = this.player;

    // 玩家：战斗中冻结；键盘优先（会取消点击路径）
    if (!pl.inBattle) {
      const { x: dx, y: dy } = this.actions.moveVector();
      if (dx || dy) {
        pl.clearPath();
        const len = Math.hypot(dx, dy);
        pl.move(dx / len, dy / len, dt, this.model);
      } else if (pl.path) {
        pl.followPath(dt, this.model);
      }
    }
    this.targetMarker.setVisible(!!pl.path);

    this.aiSystem.update(this.aiParties, this.parties, dt, time, this.model);
    const overlaps = this.collisions.update(this.parties, time);
    this.battleSystem.update(overlaps, time);

    if (this.saveDirty && this.canSaveNow()) {
      const reason = this.saveDirty; this.saveDirty = null;
      this.trySaveNow(reason);
    }

    for (const v of this.views.values()) v.sync(); // 逻辑 → 画面
    this.layoutLabels();
    if (this.debugVision) this.drawDebug();
  }
}
