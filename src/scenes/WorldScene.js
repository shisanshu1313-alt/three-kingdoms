import { createSceneInput, ACTIONS } from '../platform/input.js';
import Phaser from 'phaser';
import {
  TILE_SIZE, CAMERA_LERP, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, MINIMAP_SIZE, NEAR_PLAYER_FULL_LABEL_PX, MAP_SEED, SAVE_INTERVAL_S, TEAM_SEED
} from '../config.js';
import { generateMap, TERRAIN } from '../world/MapGenerator.js';
import PartyModel from '../systems/party.js';
import PartyView from '../entities/PartyView.js';
import { WorldModel, snapshotWorld } from '../systems/world.js';
import AISystem from '../systems/ai.js';
import FieldBattle from '../systems/fieldBattle.js';
import { inCombat, soldiersOf, shownSoldiers, moraleOf, radiusOf, vmaxOf, addSoldiers } from '../systems/melee.js';
import { assignUnit } from '../systems/units.js';
import combatJson from '../data/combat_v05.json' with { type: 'json' };
import { createGameState, pushLog } from '../systems/gameState.js';
import { buildRespawnTeam, pickStaleTeam } from '../systems/teams.js';
import { EventBus, EVENTS } from '../core/EventBus.js';
import { balance, index, loadInitialTeams, factionColor, nextBanditName, teamRng, resetWorldRandom, run as runCfg } from '../data/index.js';
import { mulberry32, streamSeed } from '../systems/rng.js';
import { makeSave, writeSave, clearSave, memFromSave, restoreGameState, META_KEY } from '../systems/save.js';
import { createRun, runTick, checkFail, onPlayerBattleEnd, onNamedDefeated, runSummary, recordUnit, targetUnitFor } from '../systems/run.js';
import { spawnPowerRange, counterAddOf } from '../systems/runConfig.js';
import { namedReinforce, factionToRefill, factionUnit, buildRefillTeam, conquestTarget, onNamedLost } from '../systems/factions.js';
import { applyRunResult, loadMeta, saveMeta } from '../systems/meta.js';
import { DEBUG_HOOKS } from '../debug.js';
import { changeUnit } from '../systems/gacha.js';
import { growHero } from '../systems/leader.js';
import { scoutRange, scoutInfo } from '../systems/scouting.js';
import { counterMult } from '../systems/melee.js';
import { createCities, cityTick, noEngage, applyChapter as cityApplyChapter, freeConqueredCapitals, capture, decline, loseCity, serviceCity,
  siegePlayerDue, siegeEmptyDue, pickSiegeTeam, pickNearbyTeam, defMax, citySide, factionsHostile, PLAYER, garrisonBasePower, garrisonRecalc, garrisonRecalcOn, garrisonRecalcOnEngage, garrisonEngageSoldiers, garrisonPreviewPower, cityLabel } from '../systems/city.js';
import { conqueredFactions } from '../systems/factions.js';
import { UNIT_FULL_NAMES } from '../systems/units.js';
import GameClock from '../core/GameClock.js';
import { getStorage } from '../platform/storage.js';
import { getLifecycle } from '../platform/lifecycle.js';

/** 标签中心 x：夹在地图内（宽 w 的标签不出左右边，pad 为额外半宽） */
export const labelX = (x, w, worldW, pad = 0) => Math.max(w / 2 + pad + 2, Math.min(worldW - w / 2 - pad - 2, x));

export default class WorldScene extends Phaser.Scene {
  constructor() { super('World'); }

  /** data.save：读档（已经过 parseSave 校验/迁移）；否则新一局（data.newRun = 开局选项 { unit, general, item, hard }） */
  create(data = {}) {
    this.loadWarnings = data.warnings ?? [];
    this.newRunOpts = data.newRun ?? {};
    // 开发 / 无界面模拟（DEBUG_HOOKS）：window.__SANGUO_SIM = { seed, manualTick } → 固定 runSeed；manualTick = 实时循环不推进逻辑，只由 debugAdvance 按固定 tick 推进
    const sim = DEBUG_HOOKS ? globalThis.__SANGUO_SIM : null;
    this.manualTick = !!sim?.manualTick;
    if (sim && Number.isInteger(sim.seed) && !data.save) this.newRunOpts = { ...this.newRunOpts, seed: sim.seed >>> 0 };
    // 模拟对比用（只在 DEBUG_HOOKS 下）：sim.tuning 覆盖 balance.v06.tuning 的键（如 TUNING=off → 关掉 T1–T3 跑基线）
    if (sim?.tuning && balance.v06?.tuning) Object.assign(balance.v06.tuning, sim.tuning);
    this.pendingEnd = null; this.ended = false;
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
    this.aiSystem = new AISystem(balance);
    this.fixedAcc = 0;
    this.fx = this.add.graphics().setDepth(9);
    this.minimap.ignore(this.fx);
    // ---- 一局（systems/run.js）：runSeed（crypto）→ 各随机数流的种子（save_v05.new_fields：runSeed + 分流 RNG）----
    const opts = this.newRunOpts;
    if (save?.run) this.run = structuredClone(save.run);
    else {
      const runSeed = DEBUG_HOOKS && Number.isInteger(opts.seed) ? opts.seed >>> 0 : cryptoSeed();
      this.run = createRun({ runId: `run-${this.manualTick ? 'sim' : Date.now().toString(36)}-${runSeed.toString(36)}`, runSeed, hard: !!opts.hard, startUnit: opts.unit ?? combatJson.confirmed.player_start_unit, cfg: runCfg });
      this.run.opts = { ...opts };
    }
    const seedRng = mulberry32(this.run.runSeed >>> 0);
    const newSeed = () => (seedRng() * 4294967296) >>> 0;
    // 存档决定 3：抽卡与战斗结算用各自的种子随机数流，状态随存档保存（读档不能重掷）
    this.rngs = { gacha: mulberry32(newSeed()), combat: mulberry32(newSeed()), spawn: mulberry32(newSeed()),
      ai: mulberry32(streamSeed(this.run.runSeed, 'ai')) }; // v0.6：AI 游荡 / 发呆也用种子流（存档 v6 起保存）
    for (const k of ['gacha', 'combat', 'spawn', 'ai']) if (save?.rng?.[k] !== undefined) this.rngs[k].setState(save.rng[k]);
    this.aiSystem.rng = this.rngs.ai;
    const initField = () => {
      // v0.5 实时战斗（systems/fieldBattle.js + melee.step）；读档时恢复战斗快照
      this.field = new FieldBattle({ combatJson, balance, gameState: this.state, rng: this.rngs.combat, seed: newSeed(),
        hooks: this.combatHooks(), restore: save?.combat ?? null });
    };
    const unitRng = mulberry32(TEAM_SEED ^ 0x5eed);
    if (save) {
      teamRng.setState(save.rng?.team ?? teamRng.getState());
      nextBanditName.setState(save.names);
      this.state = restoreGameState(save.state, createGameState(balance));
      initField();
      this.spawnCounter = save.spawn.counter;
      this.player = this.addParty(assignUnit(structuredClone(save.player.team), combatJson, unitRng), { exact: true });
      this.player.invincibleUntil = save.player.invincibleUntil ?? 0;
      for (const a of save.ai) {
        const p = this.addParty(assignUnit(structuredClone(a.team), combatJson, unitRng), { exact: true });
        p.ai = { ...memFromSave(a.mem), personality: this.aiSystem.personalityOf(p) };
      }
      this.field.pruneOrphans(new Set(this.parties.map(p => p.id))); // 快照里多余的战斗体（理论上不会有）
    } else {
      resetWorldRandom(); // 同一页面里再开新游戏也从相同的种子开始
      this.state = createGameState(balance);
      initField();
      this.spawnCounter = 0;
      const teams = loadInitialTeams();
      applyStartOptions(teams, opts);
      this.player = this.addParty(assignUnit(teams.player, combatJson, unitRng, { playerUnit: this.run.startUnit }));
      teams.ai.forEach(t => this.addParty(assignUnit(t, combatJson, unitRng)));
    }
    // ---- v0.6 城池（systems/city.js）：存在 state.cities 里随存档；旧存档由 save 迁移补上 ----
    if (!this.state.cities) this.state.cities = createCities(balance, { chapter: this.run.chapter, garrison: !save });
    this.run.city ??= {};
    this.aiSystem.cities = this.state.cities;
    if (!save) this.spawnGarrison();
    this.buildCityViews();


    // 补充刷新（balance.spawn）：每 respawn_interval_s（游戏时间）检查一次，AI 队伍（含初始）不足 max_ai_teams 就刷一支
    const T = save?.timers ?? {};
    this.applyChapter();
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
    // F1 调试视野：PM 2026-10-23 定 —— 和 F2 一样只在开发 / 冒烟测试构建（DEBUG_HOOKS）里有，正式版没有
    this.actions = createSceneInput(this, { move: true, capture: DEBUG_HOOKS ? ['F1'] : [] });
    if (DEBUG_HOOKS) this.actions.on(ACTIONS.DEBUG_VISION, ({ repeat }) => { if (!repeat) this.toggleVision(); }); // 与原 Key 'down' 一致：按住不重复切换
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
    // resize 监听：shutdown（重开 / 读档 / 结算）时解绑，否则每次 restart 多挂一个（QA a7d1348 复测 §5.1，同 UIScene）
    const onResize = () => { if (this.minimap?.scene) this.positionMinimap(); };
    this.scale.on('resize', onResize);
    this.events.once('shutdown', () => this.scale.off('resize', onResize));

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
    return !!(this.player && this.field && this.run && !this.run.over); // 一局结束后绝不再写（删档后不能被定时存档写回来）
  }

  /** 纯数据快照（存档格式见 systems/save.js；逻辑在 systems/world.js） */
  snapshot() {
    return snapshotWorld({
      clock: this.clock, state: this.state, player: this.player, aiParties: this.aiParties, spawnCounter: this.spawnCounter,
      names: nextBanditName.getState(), rngs: { team: teamRng, ...this.rngs }, combat: this.field.serialize(),
      cameraZoom: this.cameras.main.zoom, balance, run: this.run
    });
  }

  /** 请求存档：能存就在下一帧存，否则等战斗/弹窗结束 */
  requestSave(reason = 'auto') {
    if (!this.saveDirty || reason === 'manual') this.saveDirty = reason;
  }

  /** 读档（F9）：已校验的存档 → 重启大地图场景 */
  loadFrom(save, warnings = []) {
    this.scene.stop('Gacha'); this.scene.stop('Roster'); this.scene.stop('City');
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
    this.field.add(p);
    EventBus.emit(EVENTS.PARTY_SPAWNED, { party: p });
    return p;
  }

  removeParty(p) {
    this.parties = this.parties.filter(x => x !== p);
    this.aiParties = this.aiParties.filter(x => x !== p);
    this.field.remove(p.id);
    this.views.get(p)?.destroy();
    this.views.delete(p);
    EventBus.emit(EVENTS.PARTY_REMOVED, { party: p });
  }

  /** 补充刷新：落点规则见 WorldModel.respawnPosition（spawn.position_rule） */
  respawn() {
    // tuning_r1 T2：满员时撤下 1 支过弱、远离玩家、不在交战的普通黄巾队，腾位按当前章节重刷（规则见 teams.pickStaleTeam）
    if (this.aiParties.length >= balance.spawn.max_ai_teams && !this.run.over) {
      const old = pickStaleTeam(this.aiParties, this.player, balance, { namedIds: new Set(runCfg.run_goal.named) });
      if (old) { console.log(`[spawn] 撤下过弱队 ${old.name} 战${Math.round(old.power)}`); this.staleRemoved = (this.staleRemoved ?? 0) + 1; this.staleLog?.push(`${old.name}（战力 ${Math.round(old.power)}）`); this.removeParty(old); }
    }
    if (this.aiParties.length >= balance.spawn.max_ai_teams || this.run.over) return null;
    const rng = this.rngs.spawn;
    const pos = this.model.respawnPosition(this.player, balance, rng);
    if (!pos) { console.log('[spawn] 10 次未找到合法位置，跳过本次刷新'); return null; }
    const r = this.run, tS = this.clock.now / 1000;
    // polish_merged.3：没被讨伐、场上又没有该势力队伍 → 这次改为在大本营刷一支校尉军
    const fac = factionToRefill(r, this.aiParties.map(p => p.team), balance, runCfg);
    if (fac) { const p = this.spawnRefill(fac); if (p) return p; }
    const n = ++this.spawnCounter;
    // 章节缩放（chapters.spawn_power_vs_player，群雄模式 +0.1）+ 黄巾兵种分布（第 3 章起针对玩家 60 s 前的兵种）
    const team = assignUnit(buildRespawnTeam({
      id: `spawn_${n}`, position: pos, playerPower: this.player.power, powerRange: spawnPowerRange(r.chapter, runCfg, r.hard, balance.v06?.tuning),
      balance, rng, idx: index, nextName: nextBanditName
    }), combatJson, rng, { mix: runCfg.chapters[r.chapter].bandit_units, targetUnit: targetUnitFor(r, tS, runCfg, combatJson.move.counters) });
    const p = this.addParty(team);
    console.log(`[spawn] ${p.name} ${team.unit} 兵${team.soldiers} 战${Math.round(p.power)} (目标 ${Math.round(team.targetPower)}, 第${r.chapter + 1}章)`);
    return p;
  }

  /** 校尉军：大本营（home_city）附近可通行处；战力 max(120, 玩家战力) × U(0.8, 1.2)，兵种 = 势力兵种 */
  spawnRefill(faction) {
    const home = balance.ai.factions.find(f => f.id === faction)?.home;
    if (!home) return null;
    const T = TILE_SIZE, pos = this.findPassableNear(Math.floor(home.x / T), Math.floor(home.y / T));
    if (!pos) return null;
    const n = ++this.spawnCounter;
    const team = buildRefillTeam({ id: `refill_${n}`, faction, home: { x: pos.x, y: pos.y }, playerPower: this.player.power, balance, run: runCfg,
      rng: this.rngs.spawn, unit: factionUnit(faction, balance, runCfg, combatJson.named_army_units) });
    const p = this.addParty(team);
    pushLog(this.state, `${p.name} 在大本营重新集结`, this.gameTime());
    console.log(`[refill] ${p.name} ${team.unit} 兵${team.soldiers} 战${Math.round(p.power)} (目标 ${Math.round(team.targetPower)})`);
    return p;
  }

  /** 开局遭遇战（fast_pace.first_battle）：first_battle.at_s（tuning_r2 U1-B 改为 50 s，见 firstBattleAtS）时在玩家 350–450 px 处刷一支 0.6–0.8 倍战力的黄巾，直冲玩家，无视新手保护 */
  spawnRaid() {
    const fb = runCfg.first_battle, rng = this.rngs.spawn, pl = this.player;
    let pos = null;
    for (let i = 0; i < 40 && !pos; i++) {
      const ang = rng() * Math.PI * 2, d = fb.dist_px[0] + rng() * (fb.dist_px[1] - fb.dist_px[0]);
      const x = pl.x + Math.cos(ang) * d, y = pl.y + Math.sin(ang) * d;
      if (x > 20 && y > 20 && x < this.worldW - 20 && y < this.worldH - 20 && this.model.isPassable(x, y) && this.model.pathTo(pl, x, y)) pos = { x, y };
    }
    if (!pos) { console.log('[raid] 找不到落点，跳过开局遭遇战'); return null; }
    const n = ++this.spawnCounter;
    const team = assignUnit(buildRespawnTeam({ id: `raid_${n}`, position: pos, playerPower: pl.power, powerRange: fb.power_vs_player,
      balance, rng, idx: index, nextName: nextBanditName }), combatJson, rng, { mix: runCfg.chapters[0].bandit_units });
    team.raid = true;
    const p = this.addParty(team);
    this.run.raidId = p.id;
    pushLog(this.state, `${p.name} 来袭！`, this.gameTime());
    this.game.events.emit('run-event', { type: 'raid', name: p.name });
    console.log(`[raid] ${p.name} ${team.unit} 兵${team.soldiers} 战${Math.round(p.power)} 距 ${Math.round(Math.hypot(pos.x - pl.x, pos.y - pl.y))}px`);
    return p;
  }

  // ================= 一局（章节 / 失败 / 胜利） =================
  /** 当前章节 → 战斗克制倍率、群雄模式加成、AI 追击规则（新手保护 90 s、名将军追击范围） */
  applyChapter() {
    const r = this.run, ch = runCfg.chapters[r.chapter];
    this.field.state.chapter = r.chapter;
    this.field.cfg.counterAdd = counterAddOf(runCfg, r.hard);
    this.aiSystem.rules = { graceUntilS: runCfg.grace_s, namedIds: new Set(runCfg.run_goal.named), namedLeashPx: ch.named_chase_home_px };
    // v0.6：名将军第 named_in_city_chapters 章坐镇大本营；城防上限换章（chapter_change = keep：当前城防不变）
    this.aiSystem.holdNamed = balance.v06.city.named_in_city_chapters.includes(r.chapter + 1);
    if (this.state.cities) cityApplyChapter(this.state.cities, r.chapter, balance);
  }

  /** 回血 / 征兵 / 整编的城（city_v06.service_cities = own_or_neutral）：自己主城、没有守军的无主城，failure.city_radius_px 内 */
  inCity(p) {
    const R = runCfg.failure.city_radius_px;
    return Object.values(this.state.cities ?? {}).some(c => serviceCity(c) && Math.hypot(c.x - p.x, c.y - p.y) <= R);
  }

  // ================= v0.6 城池 =================
  /** 洛阳守军（city_v06.garrison）：玩家战力 × power_vs_player，坐镇城心 */
  spawnGarrison() {
    const G = balance.v06.city.garrison, c = this.state.cities[G.city];
    if (!c?.garrison) return null;
    const gPlayer = garrisonBasePower(this.player.power, balance); // tuning_r1 T4（已定）
    const team = assignUnit(buildRespawnTeam({ id: `garrison_${G.city}`, position: { x: c.x, y: c.y }, playerPower: gPlayer,
      powerRange: [G.power_vs_player, G.power_vs_player], balance, rng: this.rngs.spawn, idx: index, nextName: nextBanditName }),
    combatJson, this.rngs.spawn, { mix: runCfg.chapters[0].bandit_units });
    garrisonRecalc(team, this.player.power, balance); // T4：兵数向上取整到 ≥ max(70, 0.5 × 玩家)，记满编 garrisonFull
    Object.assign(team, { name: `${c.name}守军`, fixedName: true, cityHold: G.city, home: { x: c.x, y: c.y } });
    const p = this.addParty(team);
    console.log(`[city] ${p.name} ${team.unit} 兵${team.soldiers} 战${Math.round(p.power)}`);
    return p;
  }

  /**
   * T4 标签数值（策划 power_recalc.label）：交战中 = 守军实际战力；不在交战 = max(70, 0.5 × 当前玩家战力) × remain_frac，每秒（游戏时间）刷新一次。
   * 「强于你」按这个数值判断（cityLabel）。没开 recalc → 守军实际战力。
   */
  garrisonLabelPower(c, gar) {
    if (gar.inBattle || !garrisonRecalcOn(balance)) { this._garLabel = null; return gar.power; }
    const sec = Math.floor(this.clock.now / 1000), L = this._garLabel;
    if (L && L.city === c.id && L.sec === sec && L.id === gar.id) return L.v;
    const v = garrisonPreviewPower(gar.team, this.player.power, balance);
    this._garLabel = { city: c.id, sec, id: gar.id, v };
    return v;
  }

  cityRadiusOf(p) { const b = this.field.body(p.id); return b ? radiusOf(soldiersOf(b), this.field.cfg) : 12; }

  /** 每 tick：大本营解放、守军覆灭、攻城 / 弓箭 / 回复 / 占城 / 失守、AI 派兵攻城 */
  cityStep(dt) {
    const cs = this.state.cities, r = this.run, pl = this.player, tS = this.clock.now / 1000, C = balance.v06.city;
    if (!cs || r.over) return;
    for (const c of freeConqueredCapitals(cs, conqueredFactions(r, balance, runCfg))) this.cityLog(`${c.name} 成为无主城，可以攻占`);
    for (const c of Object.values(cs)) if (c.garrison && !this.aiParties.some(p => p.team.cityHold === c.id)) { c.garrison = null; this.cityLog(`${c.name}守军覆灭`); }
    const parties = this.parties.map(p => {
      const b = this.field.body(p.id);
      return { id: p.id, x: p.x, y: p.y, r: this.cityRadiusOf(p), faction: p.faction, unit: p.team.unit, power: p.power,
        soldiers: b && inCombat(b) ? soldiersOf(b) : p.team.soldiers, isPlayer: p.isPlayer, siegeTarget: p.team.siegeTarget ?? null, takenFrom: b?.stats?.takenFrom };
    });
    // regen_rule：玩家正在和哪些城的守军交战（melee pairs 里玩家 ↔ cityHold 队）
    const playerFightingGarrison = [];
    for (const pr of Object.values(this.field.state.pairs ?? {})) {
      const o = pr.a === pl.id ? pr.b : pr.b === pl.id ? pr.a : null;
      const g = o && this.aiParties.find(p => p.id === o);
      if (g?.team.cityHold) playerFightingGarrison.push(g.team.cityHold);
    }
    const { events, losses } = cityTick(cs, parties, { tS, dt, chapter: r.chapter, balance, move: combatJson.move, homeCity: this.state.homeCity, hostile: factionsHostile, playerFightingGarrison });
    for (const [id, n] of Object.entries(losses)) this.arrowLoss(this.parties.find(p => p.id === id), n);
    for (const e of events) {
      const c = e.city;
      if (e.type === 'breached') this.cityLog(`${c.name} 城防被攻破！`, c.owner === PLAYER ? '#ff7777' : '#ffdd55');
      else if (e.type === 'capture_ready') this.onCaptureReady(c);
      else if (e.type === 'lost') this.onCityLost(c);
    }
    // AI 攻城
    const home = this.state.homeCity && cs[this.state.homeCity];
    if (!home) return;
    const d = Math.hypot(pl.x - home.x, pl.y - home.y);
    if (siegePlayerDue(r.city, { inside: d <= C.inside_px, tS, dt, chapter: r.chapter }, balance)) this.dispatchSiege(home);
    if (siegeEmptyDue(r.city, { away: d > C.ai_siege_empty.away_px, dt, chapter: r.chapter }, balance, this.rngs.spawn)) {
      const t = pickNearbyTeam(home, this.aiTeamInfo(), balance);
      if (t) this.startSiege(this.aiParties.find(p => p.id === t.id), home, '趁主城空虚');
    }
  }

  aiTeamInfo() {
    const named = new Set(runCfg.run_goal.named);
    return this.aiParties.map(p => ({ id: p.id, faction: p.faction, power: p.power, x: p.x, y: p.y, named: named.has(p.id), garrison: !!p.team.cityHold,
      inBattle: !!p.inBattle, siegeTarget: p.team.siegeTarget ?? null }));
  }

  startSiege(p, city, why) {
    if (!p) return;
    p.team.siegeTarget = city.id; p.team.raid = false;
    this.cityLog(`${p.name} ${why}，前来攻打${city.name}！`, '#ff7744');
    this.game.events.emit('run-event', { type: 'siege', name: p.name, city: city.name });
  }

  /** 玩家在主城待太久（ai_siege_player）：最近的未讨伐势力派一支野外队，没有就刷讨伐军 */
  dispatchSiege(city) {
    const A = balance.v06.city.ai_siege_player, P = this.player.power;
    const pick = pickSiegeTeam(city, this.aiTeamInfo(), P, conqueredFactions(this.run, balance, runCfg), balance);
    if (!pick) return null;
    if (pick.team) return this.startSiege(this.aiParties.find(p => p.id === pick.team.id), city, '受命');
    const rng = this.rngs.spawn, [lo, hi] = A.spawn_dist_px;
    let pos = null;
    for (let i = 0; i < balance.v06.city.siege_spawn_tries && !pos; i++) {
      const ang = rng() * Math.PI * 2, dd = lo + rng() * (hi - lo), x = city.x + Math.cos(ang) * dd, y = city.y + Math.sin(ang) * dd;
      if (x > 20 && y > 20 && x < this.worldW - 20 && y < this.worldH - 20 && this.model.isPassable(x, y) && this.model.pathTo({ x: city.x, y: city.y, _fits: () => true, size: 16 }, x, y)) pos = { x, y };
    }
    if (!pos) { console.log('[city] 讨伐军找不到落点'); return null; }
    const n = ++this.spawnCounter;
    const team = buildRefillTeam({ id: `siege_${n}`, faction: pick.spawn, home: pos, playerPower: P, balance, run: runCfg, rng,
      unit: factionUnit(pick.spawn, balance, runCfg, combatJson.named_army_units), powerRange: A.spawn_ratio, label: '讨伐军' });
    team.refill = false;
    const p = this.addParty(team);
    console.log(`[city] ${p.name} ${team.unit} 兵${team.soldiers} 战${Math.round(p.power)} 距主城 ${Math.round(Math.hypot(pos.x - city.x, pos.y - city.y))}px`);
    this.startSiege(p, city, '出兵');
    return p;
  }

  /** 城上弓箭损兵（小数累计，满 1 扣 1；不会打到 arrow_min_soldiers 以下） */
  arrowLoss(p, n) {
    if (!p || !(n > 0)) return;
    const t = p.team, b = this.field.body(p.id), min = balance.v06.city.arrow_min_soldiers;
    t.arrowAcc = (t.arrowAcc ?? 0) + n;
    const cur = b && inCombat(b) ? soldiersOf(b) : t.soldiers;
    const k = Math.min(Math.floor(t.arrowAcc), Math.max(0, Math.floor(cur - min)));
    if (k <= 0) { if (cur <= min) t.arrowAcc = 0; return; }
    t.arrowAcc -= k;
    if (b && inCombat(b)) addSoldiers(b, -k);
    else { t.soldiers -= k; p.refresh(); this.field.refresh(p); }
  }

  cityLog(text, color = '#ffdd55') {
    pushLog(this.state, text, this.gameTime());
    this.game.events.emit('run-event', { type: 'city', text, color });
  }

  /** 占城：没有主城 → 直接立为主城；有 → 弹窗问迁都（UIScene） */
  onCaptureReady(c) {
    if (!this.state.homeCity) return this.captureCity(c.id);
    this.game.events.emit('city-prompt', { cityId: c.id, name: c.name, from: this.state.cities[this.state.homeCity].name });
  }
  captureCity(id) {
    const { city, old } = capture(this.state, id);
    for (const p of this.aiParties) if (old && p.team.siegeTarget === old.id) p.team.siegeTarget = null;
    this.run.city.insideS = 0;
    this.cityLog(old ? `迁都：${old.name} → ${city.name}（${old.name} 成为无主城）` : `攻占 ${city.name}，立为主城！`, '#aaffaa');
    this.requestSave('city');
    return city;
  }
  answerRelocate(id, yes) {
    const c = this.state.cities[id], freed = c?.devFreedOwner; // 开发 F2→2 临时放出的大本营（QA-18）
    if (c) delete c.devFreedOwner;
    if (yes) this.captureCity(id);
    else if (freed) c.owner = freed; // 选 N：大本营还给原势力，名将军不会被挤出城
    else decline(this.state, id);
  }
  onCityLost(c) {
    const { lostGenerals } = loseCity(this.state, c.id, balance, this.run.chapter);
    for (const p of this.aiParties) if (p.team.siegeTarget === c.id) p.team.siegeTarget = null;
    this.cityLog(`主城 ${c.name} 失守！${lostGenerals.length ? `存放的 ${lostGenerals.map(g => g.name).join('、')} 流散` : ''}`, '#ff5555');
    this.requestSave('city');
  }

  /** 主城存放（city_v06 / roster.store）：主城 swap_radius_px 内、不在战斗中 */
  canUseStore() {
    const id = this.state.homeCity, c = id && this.state.cities[id], pl = this.player;
    if (!c) return { ok: false, text: '还没有主城（攻下一座城就能存放武将）' };
    if (pl.inBattle) return { ok: false, text: '战斗中不能调动武将' };
    const R = balance.v06.roster.swap_radius_px;
    if (Math.hypot(c.x - pl.x, c.y - pl.y) > R) return { ok: false, text: `需在主城 ${c.name} ${R} px 内` };
    return { ok: true, city: c };
  }

  buildCityViews() {
    this.cityGfx = this.add.graphics().setDepth(4);
    this.cityTexts = {};
    for (const c of Object.values(this.state.cities)) {
      this.cityTexts[c.id] = this.add.text(c.x, c.y + balance.v06.city.radius_px + 4, '', {
        fontFamily: 'sans-serif', fontSize: '12px', color: '#ffffff', stroke: '#000', strokeThickness: 3
      }).setOrigin(0.5, 0).setDepth(5);
    }
    this.minimap.ignore(Object.values(this.cityTexts));
  }

  drawCities() {
    const g = this.cityGfx.clear(), C = balance.v06.city, ch = this.run.chapter, max = defMax(balance, ch);
    for (const c of Object.values(this.state.cities)) {
      const side = citySide(c), col = side === PLAYER ? 0x2ecc71 : side ? factionColor(side) : 0xbbbbbb;
      g.fillStyle(col, 0.18).fillCircle(c.x, c.y, C.radius_px);
      g.lineStyle(c.owner === PLAYER ? 4 : 3, col, 0.9).strokeCircle(c.x, c.y, C.radius_px);
      g.lineStyle(1, 0xffffff, 0.25).strokeCircle(c.x, c.y, C.inside_px);
      const w = 80, k = Math.max(0, Math.min(1, c.def / max)), y = c.y - C.radius_px - 10;
      g.fillStyle(0x000000, 0.7).fillRect(c.x - w / 2 - 1, y - 1, w + 2, 8);
      g.fillStyle(c.def <= 0 ? 0xff3333 : k < 0.35 ? 0xff9933 : 0x66ddff, 1).fillRect(c.x - w / 2, y, w * k, 6);
      if (c.hold > 0) g.fillStyle(0xaaffaa, 1).fillRect(c.x - w / 2, y + 8, w * c.hold / C.capture_hold_s, 3);
      if (c.lostHold > 0) g.fillStyle(0xff5555, 1).fillRect(c.x - w / 2, y + 8, w * c.lostHold / C.lost_hold_s, 3);
      const store = c.owner === PLAYER ? `  存放 ${(this.state.cityStore ?? []).length}/${balance.v06.roster.storage_max}` : '';
      const gar = c.garrison ? this.aiParties.find(p => p.team.cityHold === c.id) : null; // T4：显示守军战力（不在交战 = 按当前玩家战力重算的值；交战中 = 这一仗的守军，不变）
      const L = cityLabel(c, { max, factionName: balance.ai.factions.find(f => f.id === c.owner)?.name, storeText: store, garrisonPower: gar ? this.garrisonLabelPower(c, gar) : null, playerPower: this.player.power, strongerHint: balance.v06.city.garrison.stronger_hint });
      if (this.cityTexts[c.id].text !== L.text) this.cityTexts[c.id].setText(L.text);
      this.cityTexts[c.id].setColor(L.color);
    }
  }

  runStep(dt) {
    const r = this.run, pl = this.player;
    if (r.over) return;
    const tS = this.clock.now / 1000;
    recordUnit(r, tS, pl.team.unit);
    const ev = runTick(r, tS, dt, { soldiers: pl.team.soldiers, cap: pl.cap, power: pl.power, inBattle: pl.inBattle, inCity: this.inCity(pl) }, runCfg, balance.v06?.tuning);
    // polish_merged.4：名将军每累计 60 s（不在交战中）补兵；交战中计时暂停，战后不补算
    for (const { id, add } of namedReinforce(r, dt, this.aiParties.map(p => ({ id: p.id, soldiers: p.team.soldiers, cap: p.cap, inBattle: !!p.inBattle })), runCfg)) {
      const p = this.aiParties.find(x => x.id === id);
      if (p) { p.team.soldiers += add; p.refresh(); this.field.refresh(p); }
    }
    for (const e of ev) {
      if (e.type === 'chapter') {
        this.applyChapter();
        // v0.6 主角成长：每进入新章节 统率 +6 / 武力 +4（上限 100）；heroGrownCh 随 run 存档，读档不重复
        const n = e.idx - (r.heroGrownCh ?? e.idx - 1);
        if (n > 0) {
          const g = growHero(pl.team, balance, n); r.heroGrownCh = e.idx;
          if (g) { pl.refresh(); this.field.refresh(pl); pushLog(this.state, `主角成长：统率 +${g.lead}，武力 +${g.str}`, this.gameTime()); }
        }
        pushLog(this.state, `进入${e.chapter.name}`, this.gameTime());
        this.game.events.emit('run-event', e);
        this.requestSave('chapter'); // save_v05.autosave：换章时
      } else if (e.type === 'raid') this.spawnRaid();
      else if (e.type === 'recruit') { pl.team.soldiers += e.n; pl.refresh(); this.field.refresh(pl); }
      else if (e.type === 'fail') this.endRun();
    }
  }

  /** 城池整编（units.change_unit.city）：城池 200 px 内、不在战斗中，花 30 点全队换兵种，原地 5 s 不能移动 */
  canReorganize() {
    const C = runCfg.units.change_unit_city, pl = this.player;
    if (this.run.over) return { ok: false, text: '' };
    if (pl.inBattle) return { ok: false, text: '战斗中不能整编' };
    if (!this.inCity(pl)) return { ok: false, text: `需在城池 ${C.radius_px} px 内整编` };
    if ((pl.team.lockUntil ?? 0) > this.clock.now) return { ok: false, text: '正在整编' };
    if (this.state.points < C.cost) return { ok: false, text: `点数不足（整编需 ${C.cost} 点）` };
    return { ok: true, text: '', cost: C.cost };
  }
  reorganize(unit) {
    const chk = this.canReorganize(), pl = this.player;
    if (!chk.ok) return chk;
    if (unit === pl.team.unit) return { ok: false, text: '已经是这个兵种' };
    this.state.points -= chk.cost;
    changeUnit(pl.team, unit);
    pl.team.lockUntil = this.clock.now + runCfg.units.change_unit_city.lock_s * 1000;
    pl.clearPath(); pl.refresh(); this.field.refresh(pl);
    const text = `整编：全队改为${UNIT_FULL_NAMES[unit]}（−${chk.cost} 点，${runCfg.units.change_unit_city.lock_s} s 内不能移动）`;
    pushLog(this.state, text, this.gameTime());
    this.requestSave('reorganize');
    return { ok: true, text };
  }

  /** 放弃本局（暂停菜单）= 失败 */
  abandonRun() {
    if (this.run.over) return;
    this.run.over = { result: 'defeat', reason: 'abandon', atS: this.clock.now / 1000 };
    this.endRun();
  }

  /**
   * 一局结束（save_v05.death）：先同步删除 run 存档 → 再写局外数据（按 runId 去重）→ 再显示结算。
   * 胜利时 delete_on_victory 决定是否删档。
   */
  endRun() {
    if (this.ended) return;
    this.ended = true;
    const r = this.run, tS = this.clock.now / 1000;
    const summary = runSummary(r, r.over?.atS ?? tS, runCfg);
    const st = getStorage();
    if (r.over?.result !== 'victory' || runCfg.save.delete_on_victory) clearSave(st);
    const { meta, newUnlocks } = applyRunResult(loadMeta(st, META_KEY), summary, runCfg);
    saveMeta(st, META_KEY, meta);
    console.log(`[run] 结束 ${summary.result} (${summary.reason}) 存活 ${Math.round(tS)}s 名望 ${summary.fame} 新解锁 ${newUnlocks.map(u => u.id).join(',') || '无'}`);
    this.pendingEnd = { summary, newUnlocks: newUnlocks.map(u => ({ id: u.id, name: u.name })), meta, opts: r.opts ?? {} };
  }

  // ---- 开发 / 冒烟测试钩子（只在 DEBUG_HOOKS 构建里有效）----
  /** 快进游戏时钟：按固定 tick 跑完整模拟 sec 秒（不是跳时间，战斗 / AI / 章节都照常发生） */
  debugAdvance(sec) {
    if (!DEBUG_HOOKS) return null;
    const TICK = this.field.cfg.tick_s;
    for (let i = 0; i < Math.round(sec / TICK) && !this.pendingEnd; i++) { for (const v of this.views.values()) v.beforeTick(); this.fixedTick(TICK); }
    return this.clock.now / 1000;
  }
  debugSetHeroHp(hp) { if (!DEBUG_HOOKS) return null; this.run.heroHp = hp; return hp; }

  // ================= v0.5 实时战斗回调（FieldBattle 调用；这里只做表现 / 移除队伍 / 存档） =================
  combatHooks() {
    const playerIn = (...ps) => ps.some(p => p?.isPlayer);
    return {
      onEngage: (a, b, e) => {
        for (const x of [a, b]) if (x?.team.raid) x.team.raid = false; // 来袭队接战后按普通 AI 行动
        // T4 power_recalc：战斗体已按 env.engageSoldiers 换成重算后的兵数；这里把同样的重算记到守军队伍上（满编 / remain_frac / 面板战力）。
        // third_party：守军开战前已在交战（AI 在打守军时玩家加入）→ 战斗体没重算，队伍也不重算（e.fresh 不含守军）
        for (const [g, o] of [[a, b], [b, a]]) if (garrisonRecalcOnEngage(g?.team, o?.isPlayer, e?.fresh?.includes(g?.id), balance)) {
          garrisonRecalc(g.team, this.player.power, balance);
          g.refresh(); console.log(`[city] ${g.name} 开战重算 兵${g.team.soldiers}（满编 ${g.team.garrisonFull}）战${g.power.toFixed(1)} 玩家战力 ${this.player.power.toFixed(1)}`);
          const body = this.field.body(g.id);
          if (body && Math.abs(body.N0 - g.team.soldiers) > 1e-9) console.warn(`[city] ${g.name} 开战重算：战斗体兵数 ${body.N0} 与队伍 ${g.team.soldiers} 不一致`);
        }
        EventBus.emit(EVENTS.BATTLE_START, { battle: { a, b } });
        if (playerIn(a, b)) this.trySaveNow('battle-start'); // 存档决定 1：开战即存（含战斗快照）
      },
      onEffect: (type, p, e) => { if (p) this.combatEffect(type, p, e); },
      onBattleEnd: (battle, outcome, e) => {
        for (const id of outcome.removeIds) { const p = this.parties.find(x => x.id === id); if (p) this.removeParty(p); }
        pushLog(this.state, outcome.text, this.gameTime());
        EventBus.emit(EVENTS.BATTLE_END, { battle, outcome });
        // 名将军被击败（玩家有伤害份额）→ 讨伐进度 / 胜利
        const L = battle.b;
        // 讨伐目标：名将军；名将军被其他 AI 打掉过时，该势力的校尉军（factions.conquestTarget）
        const ct = L && conquestTarget(L.team, this.run, balance, runCfg);
        if (ct) {
          const share = e?.shares?.[this.player.id] ?? 0;
          const ev = onNamedDefeated(this.run, ct.namedId, share, this.clock.now / 1000, runCfg);
          if (ev) {
            pushLog(this.state, ev.type === 'victory' ? '四路名将尽数讨平！' : `讨平 ${L.name}（还剩 ${ev.left} 路）`, this.gameTime());
            this.game.events.emit('run-event', { ...ev, name: L.name });
            if (ev.type === 'victory') { this.endRun(); return; }
          } else if (ct.namedId === L.id && !(share > 0) && outcome.removeIds.includes(L.id) && onNamedLost(this.run, L.id, runCfg)) {
            // 名将军被其他 AI 打掉（不是玩家）：之后该势力的校尉军可算讨伐（faction_refill.counts_when_named_lost）
            pushLog(this.state, `${L.name} 被别的势力击溃，击败其校尉军也算讨平`, this.gameTime());
          }
        }
        this.requestSave('battle');
      },
      onEscape: (esc, from, e) => { // e.net：QA-14 玩家的「兵 开战前→现在」（fieldBattle.playerNet）
        const text = `${esc.name} 脱离了 ${from?.name ?? '敌军'}${e?.net ?? ''}`;
        pushLog(this.state, text, this.gameTime());
        EventBus.emit(EVENTS.BATTLE_END, { battle: { a: esc, b: from }, outcome: { text, escape: true } });
        this.combatEffect('escape', esc);
        this.requestSave('battle');
      },
      onDraw: (a, b, e) => {
        const text = `${a?.name} 与 ${b?.name} 平局，各自收兵${e?.net ?? ''}`;
        pushLog(this.state, text, this.gameTime());
        EventBus.emit(EVENTS.BATTLE_END, { battle: { a, b }, outcome: { text } });
      },
      onSeparated: (a, b, e) => { // v0.6 battle.no_contact_end_s
        const text = `${a?.name} 与 ${b?.name} 脱离接触，各自收兵${e?.net ?? ''}`;
        pushLog(this.state, text, this.gameTime());
        EventBus.emit(EVENTS.BATTLE_END, { battle: { a, b }, outcome: { text } });
        if ([a, b].some(x => x?.isPlayer)) this.requestSave('battle');
      },
      onCombatEnd: (p, e) => {
        if (!p.isPlayer || this.run.over) return;
        // 失败规则 B：每场结束扣主角 HP
        const tS = this.clock.now / 1000, dmg = onPlayerBattleEnd(this.run, e, tS, runCfg);
        if (dmg > 0) {
          pushLog(this.state, `主角负伤 −${Math.round(dmg)} HP（剩 ${Math.round(this.run.heroHp)}）`, this.gameTime());
          this.game.events.emit('run-event', { type: 'hero-hit', dmg, hp: this.run.heroHp });
        }
        if (checkFail(this.run, p.team.soldiers, tS)) { this.endRun(); return; }
        this.requestSave('battle');
      },
      onPlayerWiped: (p, e) => {
        const text = `全军覆没！${e?.net ?? ''}`;
        pushLog(this.state, text, this.gameTime());
        EventBus.emit(EVENTS.BATTLE_END, { battle: { a: p, b: null }, outcome: { text, playerDefeat: true } });
        if (checkFail(this.run, 0, this.clock.now / 1000)) this.endRun(); // 兵力 0 → 本局失败
      }
    };
  }

  /** 战斗特效：冲击 / 反冲锋 / 溃逃 / 脱离 */
  combatEffect(type, p) {
    if (!p) return;
    const map = { impact: ['冲!', '#ffdd55', 0xffdd55], braced: ['拒!', '#66ccff', 0x66ccff], rout: ['溃!', '#ff5555', 0xff5555],
      escape: ['脱离', '#88ffff', 0x88ffff], 'rout-recover': ['重整', '#aaffaa', 0xaaffaa], 'protect-cancel': ['出击', '#ffaa66', 0xffaa66],
      join: ['加入!', '#ff88ff', 0xff88ff], pursue: ['追!', '#ff9944', 0xff9944], giveup: ['不追了', '#cccccc', 0xcccccc], retreat: ['撤!', '#bbbbff', 0xbbbbff] };
    const [txt, col, ring] = map[type] ?? [type, '#ffffff', 0xffffff];
    const r = radiusOf(p.soldiers, this.field.cfg);
    const c = this.add.circle(p.x, p.y, r + 4).setStrokeStyle(3, ring).setDepth(12);
    // QA-12：「追!」「溃!」等飘字放在队伍标签上方（以前在圆上方 18 px，正好压在队伍名上）；同一队短时间内多个飘字依次往上错开
    const v = this.views.get(p), lab = v?.label, now = this.time.now, fx = v ?? {};
    fx.fxStack = now - (fx.fxAt ?? -1e9) < 600 ? (fx.fxStack ?? 0) + 1 : 0; fx.fxAt = now;
    const fy = (lab ? Math.min(lab.y - lab.height, p.y - r - 12) : p.y - r - 12) - 2 - fx.fxStack * 20;
    const t = this.add.text(labelX(p.x, 0, this.worldW, 30), fy, txt, { fontSize: '18px', color: col, stroke: '#000', strokeThickness: 4, fontStyle: 'bold' }).setOrigin(0.5, 1).setDepth(13);
    this.minimap.ignore([c, t]);
    this.tweens.add({ targets: c, scale: 1.8, alpha: 0, duration: 450, onComplete: () => c.destroy() });
    this.tweens.add({ targets: t, y: t.y - 24, alpha: 0, duration: 900, onComplete: () => t.destroy() });
    console.log(`[fx] ${type} ${p.name}`);
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
    if (!DEBUG_HOOKS) return false;
    this.debugVision = on;
    if (!on) this.debugGfx.clear();
    return on;
  }

  drawDebug() {
    if (!DEBUG_HOOKS) return;
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
    const range = scoutRange(pl.team, balance), counters = this.field.cfg.move.counters;
    const mult = counterMult(this.field.cfg, this.run.chapter) + (this.field.cfg.counterAdd ?? 0);
    const me = { unit: pl.team.unit, power: pl.power, soldiers: pl.soldiers };
    for (const p of order) {
      const v = this.views.get(p);
      const sc = p.isPlayer ? null : scoutInfo({ me, them: { unit: p.team.unit, power: p.power, soldiers: p.soldiers }, dist: Math.hypot(p.x - pl.x, p.y - pl.y), range, counters, mult });
      v.setScout(sc);
      const hovered = Math.abs(pw.x - p.x) < p.size && Math.abs(pw.y - p.y) < p.size;
      const b = this.field.body(p.id);
      if (p.inBattle && b) {
        v.setBattleLabel(shownSoldiers(b)); // 兵数随 tick 实时下降
      } else {
        v.setLabelMode(p.isPlayer || hovered || Math.hypot(p.x - pl.x, p.y - pl.y) < NEAR_PLAYER_FULL_LABEL_PX);
      }
      const w = v.label.width, h = v.label.height;
      // QA-13：标签横向夹在地图内（地图左 / 右边缘的队伍名不再被切掉半截）；顶边放不下就放到圆下面
      const lx = labelX(v.body.x, w, this.worldW);
      let bottom = v.body.y - v.radius - 12; // 留出兵数条 / 士气条
      for (let iter = 0; iter < 8; iter++) {
        const hit = placed.find(r => lx - w / 2 < r.right && lx + w / 2 > r.left && bottom - h < r.bottom && bottom > r.top);
        if (!hit) break;
        bottom = hit.top - 1;
      }
      if (bottom - h < 0) bottom = v.body.y + v.radius + 14 + h;
      v.label.setPosition(lx, bottom);
      placed.push({ left: lx - w / 2, right: lx + w / 2, top: bottom - h, bottom });
      // 战斗中/无敌提示色
      v.label.setColor(p.inBattle ? '#ff8888' : (p.isInvincible(this.clock.now) ? '#88ffff' : (sc ? sc.color : '#ffffff')));
    }
  }

  // ================= 主循环 =================
  /** 一个固定 tick：玩家输入 → AI → 实时战斗 step → 存档 */
  fixedTick(dt) {
    this.clock.tick(dt * 1000);
    const time = this.clock.now, pl = this.player;
    // 玩家：战斗中照常操控（v0.5：撤退 = 把队伍开走）；键盘优先（会取消点击路径）
    const { x: dx, y: dy } = this.actions.moveVector();
    if ((pl.team.lockUntil ?? 0) > time) { pl.clearPath(); } // 整编中：原地不动
    else if (dx || dy) {
      pl.clearPath();
      const len = Math.hypot(dx, dy);
      pl.move(dx / len, dy / len);
    } else if (pl.path) {
      pl.followPath(dt, this.model);
    }
    this.targetMarker.setVisible(!!pl.path);
    this.aiSystem.update(this.aiParties, this.parties, dt, time, this.model);
    this.field.tick(dt, this.combatEnv(), time);
    if (this.pendingEnd) return;
    this.cityStep(dt);
    this.runStep(dt);
    if (this.pendingEnd) return;
    // save_v05.in_battle：玩家交战中每 1 s 写一次战斗快照
    if (pl.inBattle && time - (this.lastSaveAt ?? -1e9) >= 1000) this.trySaveNow('battle-snapshot');
  }

  /** 战斗用的地形接口（纯函数，给 melee.step） */
  combatEnv() {
    if (!this._env) {
      const m = this.model, pl = this.player;
      this._env = {
        fits: (b, x, y) => pl._fits(x, y, m),
        speedMult: (x, y) => m.speedAt(x, y),
        hostile: (a, b) => factionsHostile(a.faction, b.faction),
        noEngage: (a, b) => noEngage(a, b, this.state.cities, balance), // v0.6 城内保护
        // T4 power_recalc：玩家和洛阳守军开战的那一刻，守军兵数按当时玩家战力重算（× remain_frac）
        engageSoldiers: (X, Y) => {
          const g = this.aiParties.find(p => p.id === X.id);
          return g?.team.cityHold ? garrisonEngageSoldiers(g.team, Y.id === this.player.id, this.player.power, balance) : null;
        }
      };
    }
    return this._env;
  }

  /** 接触线 / 弓兵箭线 / 脱离倒计时 */
  drawCombatFx() {
    const g = this.fx.clear(), f = this.field, cfg = f.cfg;
    for (const p of Object.values(f.state.pairs)) {
      const a = this.parties.find(x => x.id === p.a), b = this.parties.find(x => x.id === p.b);
      if (!a || !b) continue;
      const va = this.views.get(a).body, vb = this.views.get(b).body;
      g.lineStyle(p.wasContact ? 4 : 2, p.wasContact ? 0xff3333 : 0xff9999, p.wasContact ? 0.9 : 0.5).lineBetween(va.x, va.y, vb.x, vb.y);
      if (p.apartT > 0) { // 脱离进度：间隙 > escape_gap_px 已持续 apartT / escape_s
        const mx = (va.x + vb.x) / 2, my = (va.y + vb.y) / 2, k = p.apartT / cfg.move.escape_s;
        g.lineStyle(4, 0x88ffff, 0.9).beginPath().arc(mx, my, 14, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2).strokePath();
      }
    }
    for (const b of Object.values(f.state.bodies)) if (b.shooting) {
      const a = this.parties.find(x => x.id === b.id), t = this.parties.find(x => x.id === b.shooting);
      if (a && t) g.lineStyle(1, 0xffffaa, 0.8).lineBetween(this.views.get(a).body.x, this.views.get(a).body.y, this.views.get(t).body.x, this.views.get(t).body.y);
    }
  }

  update(_time, delta) {
    // 固定 tick（battle_move.tick_s = 0.1 s）：游戏时钟、玩家输入、AI、战斗 step 都按 tick 推进；画面每帧在两次 tick 之间插值。
    // 本场景暂停时 update 不执行 → 全部冻结（v0.4 pause_scope）
    const TICK = this.field.cfg.tick_s * 1000;
    this.fixedAcc = this.manualTick ? 0 : this.fixedAcc + Math.min(delta, 250); // manualTick（模拟）：只由 debugAdvance 推进
    while (this.fixedAcc >= TICK && !this.pendingEnd) {
      this.fixedAcc -= TICK;
      for (const v of this.views.values()) v.beforeTick();
      this.fixedTick(TICK / 1000);
    }
    if (this.pendingEnd) { // 结算（存档已删、局外数据已写）→ 结算画面
      const d = this.pendingEnd; this.pendingEnd = null;
      for (const k of ['Gacha', 'Roster', 'City', 'UI']) this.scene.stop(k);
      this.scene.start('RunEnd', d);
      return;
    }
    if (this.saveDirty && this.canSaveNow()) {
      const reason = this.saveDirty; this.saveDirty = null;
      this.trySaveNow(reason);
    }

    const alpha = this.fixedAcc / TICK, now = this.clock.now;
    for (const v of this.views.values()) v.sync(alpha, this.field.body(v.model.id), now); // 逻辑 → 画面（插值）
    this.drawCombatFx();
    this.drawCities();
    this.layoutLabels();
    if (DEBUG_HOOKS && this.debugVision) this.drawDebug();
  }
}

/** 32 位随机种子：优先 crypto（save_v05：runSeed 用 crypto 生成） */
function cryptoSeed() {
  try { return globalThis.crypto.getRandomValues(new Uint32Array(1))[0]; } catch { return (Math.random() * 4294967296) >>> 0; }
}

/** 局外解锁的开局选项：随从（从原队伍移到玩家队）、开局物品（替换战鼓） */
function applyStartOptions(teams, opts) {
  const pl = teams.player;
  if (opts.general) {
    for (const t of teams.ai) t.generals = t.generals.filter(g => g.id !== opts.general);
    const g = index.generalsById[opts.general];
    if (g && !pl.generals.some(x => x.id === g.id)) pl.generals.push({ id: g.id, name: g.name, ...(g.tier ? { tier: g.tier } : {}), lead: g.lead, str: g.str, int: g.int, cha: g.cha });
  }
  if (opts.item && opts.item !== 'war_drum') pl.items = pl.items.map(i => (i === 'war_drum' ? opts.item : i));
}
