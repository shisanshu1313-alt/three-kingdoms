import { createSceneInput, ACTIONS, DEFAULT_BINDINGS, KEY_CODES, withKeys } from '../platform/input.js';
import Phaser from 'phaser';
import { MINIMAP_SIZE, TILE_SIZE, MAP_SEED } from '../config.js';
import { loadSave } from '../systems/save.js';
import { getStorage } from '../platform/storage.js';
import { EventBus, EVENTS } from '../core/EventBus.js';
import { balance, run as runCfg } from '../data/index.js';
import { DEBUG_HOOKS } from '../debug.js';
import { button } from '../ui/widgets.js';
import { drawCost, gachaState } from '../systems/gachaOffer.js';
import { shownSoldiers, moraleOf, inCombat, vmaxOf } from '../systems/melee.js';
import { UNIT_NAMES, UNIT_FULL_NAMES } from '../systems/units.js';
import { UNIT_ORDER_UNITS } from '../systems/gacha.js';
import StatsHud from '../ui/StatsHud.js';

const UI_CFG = balance.gacha_ui ?? {};
const DEBUG_POINTS = 200;

// UI 覆盖层：坐标、地形、FPS、小地图边框、碰撞提示
export default class UIScene extends Phaser.Scene {
  constructor() { super('UI'); }

  create(data = {}) {
    this.world = this.scene.get('World');
    this.stats = null; // 场景重启（再来一局 / 读档）时，上一局的 StatsHud 已随场景销毁
    const style = { fontFamily: 'monospace', fontSize: '14px', color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.55)', padding: { x: 8, y: 6 } };
    this.info = this.add.text(10, 10, '', style).setScrollFactor(0);
    this.help = this.add.text(10, 0, 'WASD/方向键 移动 · 左键点击 寻路移动 · 滚轮 缩放 · 悬停队伍看详情 · G 抽卡 · H 主城存放武将 · B 城中整编 · C 属性详情 · P 暂停 / 放弃本局 · F1 调试（视野/路径）' + (DEBUG_HOOKS ? ' · F5 存档 · F9 读档（开发）' : '') + (import.meta.env.DEV ? ' · F2 调试加点' : ''), { ...style, fontSize: '12px' }).setScrollFactor(0);

    this.minimapFrame = this.add.graphics();
    this.toasts = [];

    this.layout();
    this.scale.on('resize', () => this.layout());

    // 抽卡 HUD 按钮（gacha_ui.hud_button）+ 键盘 G；F2 = 调试加点
    this.gachaBtn = button(this, 0, 0, 120, 34, `抽卡 [${UI_CFG.open_key ?? 'G'}]`, () => this.openGacha(), { color: 0x8e5a00, size: 15 });
    // 动作：G 抽卡（键位取 gacha_ui.open_key）、F5 存档 / F9 读档（阻止浏览器默认的 F5 刷新）、F2 调试加点（仅开发模式）
    const openKey = KEY_CODES[(UI_CFG.open_key ?? 'G').toUpperCase()] ?? Phaser.Input.Keyboard.KeyCodes[(UI_CFG.open_key ?? 'G').toUpperCase()];
    const act = createSceneInput(this, {
      bindings: withKeys(DEFAULT_BINDINGS, ACTIONS.OPEN_GACHA, [openKey]), pointer: false,
      capture: DEBUG_HOOKS ? (import.meta.env.DEV ? ['F2', 'F5', 'F9'] : ['F5', 'F9']) : []
    });
    act.on(ACTIONS.OPEN_GACHA, () => { if (!this.pauseUi) this.openGacha(); });
    // HUD 属性：常显小面板 + C / [属性 C] 按钮展开详情（不暂停游戏）
    this.stats = new StatsHud(this, { getParty: () => this.world.player, getCfg: () => this.world.field?.cfg, balance });
    act.on(ACTIONS.TOGGLE_STATS, ({ repeat }) => { if (!repeat) this.stats.toggle(); });
    // save_v05.dev：F5 / F9 只在开发 / 冒烟构建里有（正式版只有自动存档）
    if (DEBUG_HOOKS) { act.on(ACTIONS.SAVE, () => this.manualSave()); act.on(ACTIONS.LOAD, () => this.manualLoad()); }
    // 暂停菜单：P 打开 / 关闭；菜单里 Y = 放弃本局（按失败结算）
    act.on(ACTIONS.PAUSE, () => this.togglePause());
    act.on(ACTIONS.YES, () => {
      if (this.cityPrompt) { this.answerCity(true); return true; }
      if (this.pauseUi) { this.closePause(false); this.world.abandonRun(); return true; }
    });
    act.on(ACTIONS.NO, () => { if (this.cityPrompt) { this.answerCity(false); return true; } });
    // v0.6 主城存放：H（主城 swap_radius_px 内、不在战斗中）
    act.on(ACTIONS.CITY, () => { if (!this.pauseUi && !this.cityPrompt) this.openCity(); });
    const onCityPrompt = d => this.showCityPrompt(d);
    this.game.events.on('city-prompt', onCityPrompt);
    this.events.once('shutdown', () => this.game.events.off('city-prompt', onCityPrompt));
    act.on(ACTIONS.CANCEL, () => { if (this.pauseUi) { this.closePause(); return true; } if (this.reorgUi) { this.closeReorg(); return true; } });
    // 城池整编：B 打开面板，数字键 1~4 选兵种，0 / Esc 取消
    act.on(ACTIONS.REORGANIZE, () => this.toggleReorg());
    act.on(ACTIONS.CHOOSE, ({ n }) => {
      if (!this.reorgUi) return;
      if (n === 0) return this.closeReorg();
      const u = UNIT_ORDER_UNITS[n - 1]; if (!u) return;
      const r = this.world.reorganize(u);
      this.toast(r.text, r.ok ? '#aaffaa' : '#ff8888', 15);
      if (r.ok) this.closeReorg();
    });
    const onRun = e => this.onRunEvent(e);
    this.game.events.on('run-event', onRun);
    this.events.once('shutdown', () => this.game.events.off('run-event', onRun));
    if (import.meta.env.DEV) { // 只在开发模式（npm run dev）注册；生产构建里整段被移除
      act.on(ACTIONS.DEBUG_POINTS, () => { this.world.debugGrantPoints(DEBUG_POINTS); this.toast(`【调试】点数 +${DEBUG_POINTS}`, '#88ccff', 14); });
    }
    const onSaved = ({ reason }) => { if (reason === 'manual') this.toast('已存档', '#aaffaa', 16); };
    this.game.events.on('game-saved', onSaved);
    this.events.once('shutdown', () => this.game.events.off('game-saved', onSaved));
    if (data.loaded) this.time.delayedCall(100, () => {
      this.toast('已读取存档', '#aaffaa', 16);
      // save_v05.in_battle：读档时正在交战 → 暂停，倒计时 3 s 后“继续战斗”
      if (this.world.player?.inBattle) this.resumeCountdown(runCfg.save.resume_countdown_s);
      else this.reopenPendingChoice();
    });
    for (const w of data.warnings ?? []) this.time.delayedCall(200, () => this.toast(w, '#ffdd55', 14));
    this.game.events.on('modal-closed', this.onModalClosed, this);
    this.events.once('shutdown', () => this.game.events.off('modal-closed', this.onModalClosed, this));

    this.log = this.add.text(10, 0, '', { ...style, fontSize: '12px', fontFamily: 'sans-serif', wordWrap: { width: 460 } }).setOrigin(0, 1);
    this.layout();

    const involvesPlayer = (...ps) => ps.some(p => p && p.isPlayer);
    const handlers = {
      [EVENTS.BATTLE_START]: ({ battle }) => {
        if (involvesPlayer(battle.a, battle.b)) this.toast(`⚔ ${battle.a.name} 与 ${battle.b.name} 交战！`);
      },
      [EVENTS.BATTLE_END]: ({ battle, outcome }) => {
        const mine = involvesPlayer(battle.a, battle.b);
        this.toast(outcome.text, mine ? (outcome.playerDefeat ? '#ff7777' : '#aaffaa') : '#cccccc', mine ? 16 : 13);
        // roster.trigger：俘获导致满编 → 结算后立即弹出替换/释放（暂停大地图）
        if (this.world.state.pendingGenerals.length) this.time.delayedCall(0, () => this.openRoster());
      },
      [EVENTS.AI_STATE]: ({ party, to, targetId }) => {
        if (targetId === 'player') this.toast(to === 'chase' ? `${party.name} 正在追击你！` : `${party.name} 望风而逃`, '#ffbb66', 14);
      }
    };
    for (const [ev, fn] of Object.entries(handlers)) EventBus.on(ev, fn);
    this.events.once('shutdown', () => { for (const [ev, fn] of Object.entries(handlers)) EventBus.off(ev, fn); });
  }

  // ================= v0.5 一局 =================
  onRunEvent(e) {
    if (e.type === 'chapter') this.banner(e.chapter.name, `克制倍率 ×${e.chapter.counter_mult} · 敌军更强了`, '#ffdd55');
    else if (e.type === 'raid') this.toast(`⚠ ${e.name} 来袭！`, '#ff7744', 18);
    else if (e.type === 'hero-hit') this.toast(`主角负伤 −${Math.round(e.dmg)} HP（剩 ${Math.round(e.hp)}）`, e.hp < 30 ? '#ff5555' : '#ffaa88', 16);
    else if (e.type === 'named') this.banner(`讨平 ${e.name}`, `还剩 ${e.left} 路名将`, '#aaffaa');
    else if (e.type === 'city') this.toast(e.text, e.color ?? '#ffdd55', 16);
    else if (e.type === 'siege') this.banner(`${e.name} 来攻${e.city}！`, '回城守住城防，或趁城防在时躲进城里', '#ff7744');
  }

  // ================= v0.6 城池 =================
  /** 已有主城时占新城：问是否迁都（暂停大地图；Y 迁 / N 不迁） */
  showCityPrompt({ cityId, name, from }) {
    if (this.cityPrompt) return;
    this.scene.pause('World');
    const { width: w, height: h } = this.scale;
    const c = this.add.container(0, 0).setDepth(60);
    c.add(this.add.rectangle(0, 0, w, h, 0x000000, 0.55).setOrigin(0).setInteractive());
    c.add(this.add.rectangle(w / 2, h * 0.42, 560, 170, 0x1b2a1f, 0.98).setStrokeStyle(2, 0x2ecc71));
    c.add(this.add.text(w / 2, h * 0.42 - 52, `攻占 ${name}`, { fontFamily: 'sans-serif', fontSize: '26px', color: '#aaffaa', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5));
    c.add(this.add.text(w / 2, h * 0.42 - 12, `迁都到 ${name}？${from} 会变成无主城，存放的武将跟着走。`, { fontFamily: 'sans-serif', fontSize: '15px', color: '#ffffff' }).setOrigin(0.5));
    c.add(button(this, w / 2 - 230, h * 0.42 + 24, 210, 40, '[Y] 迁都', () => this.answerCity(true), { color: 0x1e6b3a }));
    c.add(button(this, w / 2 + 20, h * 0.42 + 24, 210, 40, '[N] 不迁', () => this.answerCity(false)));
    this.cityPrompt = { cityId, c };
  }
  answerCity(yes) {
    const p = this.cityPrompt; if (!p) return;
    this.cityPrompt = null; p.c.destroy();
    this.world.answerRelocate(p.cityId, yes);
    if (!this.modalOpen() && !this.pauseUi) this.scene.resume('World');
  }
  openCity() {
    if (this.modalOpen() || this.time.now - (this.modalClosedAt ?? -1e9) < 250) return;
    const chk = this.world.canUseStore();
    if (!chk.ok) return this.toast(chk.text, '#ff8888', 15);
    this.world.trySaveNow('modal');
    this.scene.pause('World');
    this.scene.launch('City');
    this.scene.bringToTop('City');
  }

  /** 屏幕中央大字横幅（换章 / 讨平名将） */
  banner(title, sub, color) {
    const { width: w, height: h } = this.scale;
    const c = this.add.container(w / 2, h * 0.3).setDepth(50);
    c.add(this.add.rectangle(0, 0, 520, 90, 0x000000, 0.65).setStrokeStyle(2, 0xf1c40f));
    c.add(this.add.text(0, -16, title, { fontFamily: 'sans-serif', fontSize: '30px', color, stroke: '#000', strokeThickness: 4 }).setOrigin(0.5));
    c.add(this.add.text(0, 22, sub, { fontFamily: 'sans-serif', fontSize: '15px', color: '#dddddd' }).setOrigin(0.5));
    this.tweens.add({ targets: c, alpha: 0, delay: 2200, duration: 600, onComplete: () => c.destroy() });
  }

  togglePause() {
    if (this.pauseUi) return this.closePause();
    if (this.modalOpen() || this.countdownUi) return;
    this.scene.pause('World');
    const { width: w, height: h } = this.scale;
    const c = this.add.container(0, 0).setDepth(60);
    c.add(this.add.rectangle(0, 0, w, h, 0x000000, 0.6).setOrigin(0));
    c.add(this.add.text(w / 2, h * 0.36, '暂停', { fontFamily: 'sans-serif', fontSize: '36px', color: '#ffffff', stroke: '#000', strokeThickness: 4 }).setOrigin(0.5));
    c.add(button(this, w / 2 - 120, h * 0.45, 240, 44, '继续 [P / Esc]', () => this.closePause(), { color: 0x8e5a00, size: 17 }));
    c.add(button(this, w / 2 - 120, h * 0.45 + 56, 240, 44, '放弃本局 [Y]', () => { this.closePause(false); this.world.abandonRun(); }, { color: 0x7f3b3b, size: 17 }));
    c.add(this.add.text(w / 2, h * 0.45 + 116, '放弃 = 本局失败（存档删除，名望照常计入）', { fontFamily: 'sans-serif', fontSize: '13px', color: '#ffaaaa' }).setOrigin(0.5));
    this.pauseUi = c;
  }

  toggleReorg() {
    if (this.reorgUi) return this.closeReorg();
    if (this.modalOpen() || this.pauseUi) return;
    const chk = this.world.canReorganize();
    if (!chk.ok) return this.toast(chk.text, '#ff8888', 15);
    const { width: w, height: h } = this.scale, cur = this.world.player.team.unit;
    const c = this.add.container(w / 2 - 300, h - 150).setDepth(55);
    c.add(this.add.rectangle(0, 0, 600, 92, 0x000000, 0.75).setOrigin(0).setStrokeStyle(2, 0xf1c40f));
    c.add(this.add.text(12, 8, `整编（${chk.cost} 点，之后 ${runCfg.units.change_unit_city.lock_s} s 不能移动；操练等级清零）· 数字键选择，0 / Esc 取消`, { fontFamily: 'sans-serif', fontSize: '13px', color: '#ffdd55' }));
    UNIT_ORDER_UNITS.forEach((u, i) => c.add(button(this, 12 + i * 145, 38, 135, 40, `[${i + 1}] ${UNIT_FULL_NAMES[u]}${u === cur ? '（现）' : ''}`, () => {
      const r = this.world.reorganize(u); this.toast(r.text, r.ok ? '#aaffaa' : '#ff8888', 15); if (r.ok) this.closeReorg();
    })));
    this.reorgUi = c;
  }
  closeReorg() { this.reorgUi?.destroy(); this.reorgUi = null; }

  closePause(resume = true) {
    this.pauseUi?.destroy(); this.pauseUi = null;
    if (resume && !this.modalOpen()) this.scene.resume('World');
  }

  /** 读档回到战斗中：暂停 n 秒倒计时（真实时间），然后继续 */
  resumeCountdown(n) {
    this.scene.pause('World');
    const { width: w, height: h } = this.scale;
    const t = this.add.text(w / 2, h * 0.4, '', { fontFamily: 'sans-serif', fontSize: '34px', color: '#ffdd55', stroke: '#000', strokeThickness: 5 }).setOrigin(0.5).setDepth(60);
    this.countdownUi = t;
    let left = n;
    const tick = () => {
      if (left <= 0) { t.destroy(); this.countdownUi = null; this.scene.resume('World'); this.reopenPendingChoice(); return; }
      t.setText(`继续战斗 ${left}`); left--;
      this.time.delayedCall(1000, tick);
    };
    tick();
  }

  manualSave() {
    if (this.modalOpen()) return this.toast('请先关闭当前窗口再存档', '#ff8888', 15);
    if (this.world.trySaveNow('manual')) return;
    this.world.requestSave('manual');
    this.toast('战斗进行中，结束后自动存档', '#ffdd55', 15);
  }

  manualLoad() {
    if (this.modalOpen()) return this.toast('请先关闭当前窗口再读档', '#ff8888', 15);
    const r = loadSave({ balance, mapSeed: MAP_SEED }, getStorage());
    if (!r.ok) return this.toast(r.code === 'empty' ? '没有存档' : r.message, '#ff8888', 15);
    this.world.loadFrom(r.save, r.warnings);
  }

  modalOpen() { return this.scene.isActive('Gacha') || this.scene.isPaused('Gacha') || this.scene.isActive('Roster') || this.scene.isActive('City') || !!this.cityPrompt; }

  /** 存档决定 1：读档后若有没做完的选择（抽卡选武将 / 物品栏满 / 满编安排），重新弹出对应窗口 */
  reopenPendingChoice() {
    if (this.modalOpen()) return;
    const st = this.world.state;
    if (gachaState(st).offer) return this.openGacha({ force: true }); // v0.6：未选完的 4 张优先恢复
    if (st.pendingGenerals.length) this.openRoster();
  }

  /** gacha_ui.allowed_when：不在战斗中且没有待安排武将（有则先弹出名册窗口） */
  openGacha({ force = false } = {}) {
    if (this.modalOpen()) return;
    if (!force && this.world.player.inBattle) return this.toast('战斗中不能抽卡', '#ff8888', 15);
    if (this.world.state.pendingGenerals.length && !gachaState(this.world.state).offer) return this.openRoster();
    this.world.trySaveNow('modal'); // 存档决定 1：打开窗口前立即存档
    if (UI_CFG.pause_world !== false) this.scene.pause('World');
    this.scene.launch('Gacha');
    this.scene.bringToTop('Gacha');
  }

  openRoster() {
    if (this.modalOpen() || !this.world.state.pendingGenerals.length) return;
    this.world.trySaveNow('modal'); // 存档决定 1：打开窗口前立即存档
    this.scene.pause('World');
    this.scene.launch('Roster');
    this.scene.bringToTop('Roster');
  }

  onModalClosed() {
    this.modalClosedAt = this.time.now; // 同一次按键（如名册里的 H）不要接着打开别的窗口
    this.time.delayedCall(0, () => {
      if (this.world.state.pendingGenerals.length && !this.modalOpen()) return this.openRoster();
      if (!this.modalOpen() && this.scene.isPaused('World')) this.scene.resume('World');
    });
  }

  hitsHud(pointer) {
    if (this.stats?.hits(pointer.x, pointer.y)) return true;
    const b = this.gachaBtn;
    return b && pointer.x >= b.x && pointer.x <= b.x + 120 && pointer.y >= b.y && pointer.y <= b.y + 34;
  }

  layout() {
    const w = this.scale.width, h = this.scale.height;
    if (this.gachaBtn) this.gachaBtn.setPosition(w - MINIMAP_SIZE - 10, MINIMAP_SIZE + 20);
    this.help.setPosition(10, h - 30);
    this.stats?.layout();
    if (this.log) this.log.setPosition(10, h - 36);
    const x = w - MINIMAP_SIZE - 10, y = 10;
    this.minimapRect = { x, y };
    this.minimapFrame.clear().lineStyle(2, 0xffffff, 1).strokeRect(x - 1, y - 1, MINIMAP_SIZE + 2, MINIMAP_SIZE + 2);
  }

  toast(msg, color = '#ffdd55', size = 18) {
    const w = this.scale.width;
    while (this.toasts.length >= 5) { const old = this.toasts.shift(); old.destroy(); }
    const t = this.add.text(w / 2, 60 + this.toasts.length * 28, msg, {
      fontFamily: 'sans-serif', fontSize: `${size}px`, color, stroke: '#000', strokeThickness: 4
    }).setOrigin(0.5, 0);
    this.toasts.push(t);
    this.tweens.add({
      targets: t, alpha: 0, delay: 1500, duration: 500,
      onComplete: () => { t.destroy(); this.toasts = this.toasts.filter(x => x !== t); }
    });
  }

  /** HUD 主城行：主城 / 城防 / 存放；附近城池的城防与占城进度 */
  cityLine(p) {
    const st = this.world.state, cs = st.cities;
    if (!cs) return '';
    const max = c => balance.v06.city.def_by_chapter[Math.min(3, this.world.run.chapter)];
    const home = st.homeCity && cs[st.homeCity];
    const near = Object.values(cs).map(c => ({ c, d: Math.hypot(c.x - p.x, c.y - p.y) })).sort((a, b) => a.d - b.d)[0];
    const homeTxt = home ? `主城: ${home.name} 城防 ${Math.ceil(home.def)}/${max(home)}  存放 ${(st.cityStore ?? []).length}/${balance.v06.roster.storage_max}` : '主城: 无（攻下洛阳 / 被讨伐势力的大本营即可立为主城）';
    const nearTxt = near && near.d <= 300 && near.c !== home ? `  附近 ${near.c.name} 城防 ${Math.ceil(near.c.def)}/${max(near.c)}${near.c.hold > 0 ? ` 占城 ${near.c.hold.toFixed(1)}/${balance.v06.city.capture_hold_s}s` : ''}` : '';
    return homeTxt + nearTxt;
  }

  update() {
    const p = this.world.player;
    if (!p) return;
    const st = this.world.state, now = this.world.clock.now;
    const f = this.world.field, b = f?.body(p.id);
    const inv = p.isInvincible(now) ? `  保护${((p.invincibleUntil - now) / 1000).toFixed(1)}s` : '';
    const status = p.inBattle ? '交战中' : (p.path ? '行军' : '待命');
    const t = this.world.tileAt(p.x, p.y);
    const tx = Math.floor(p.x / TILE_SIZE), ty = Math.floor(p.y / TILE_SIZE);
    // v0.5 战斗行：实时兵数 / 士气 / 对手（兵种、克制）/ 脱离进度
    let battle = '';
    if (b && (inCombat(b) || b.routed)) {
      const foes = b.foes.map(id => f.body(id)).filter(Boolean);
      const foeTxt = foes.map(y => {
        const K = f.cfg.move.counters, c = K[b.unit] === y.unit ? '(克)' : K[y.unit] === b.unit ? '(被克)' : '';
        return `${f.parties.get(y.id)?.team.name ?? y.id}[${UNIT_NAMES[y.unit] ?? '?'}]${c}`;
      }).join('、');
      const apart = Math.max(0, ...Object.values(f.state.pairs).filter(q => q.a === p.id || q.b === p.id).map(q => q.apartT || 0));
      battle = `战斗: 兵${shownSoldiers(b)}/${b.N0start ?? b.N0}  士气${Math.round(moraleOf(b, f.cfg))}${b.routed ? '（溃逃！）' : ''}  对手: ${foeTxt}` +
        (apart > 0 ? `  脱离 ${apart.toFixed(1)}/${f.cfg.move.escape_s}s` : '');
    }
    const shownN = b && inCombat(b) ? shownSoldiers(b) : p.soldiers;
    const spd = b ? vmaxOf(b, f.cfg) : p.moveSpeed();
    const r = this.world.run, tS = now / 1000, ch = runCfg.chapters[r.chapter];
    const grace = tS < runCfg.grace_s ? `  新手保护 ${Math.ceil(runCfg.grace_s - tS)}s` : '';
    const fmt = x => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
    this.info.setText([
      `${ch.name} ${fmt(tS)}/${runCfg.duration_min}:00  主角HP ${Math.ceil(r.heroHp)}/${runCfg.failure.hero_hp_max}  讨平名将 ${r.namedDefeated.length}/${runCfg.run_goal.named.length}${r.hard ? '  群雄模式' : ''}${grace}${this.world.inCity(p) ? '  城中（回血/征兵）' : ''}`,
      `坐标: (${tx}, ${ty})  像素: (${Math.round(p.x)}, ${Math.round(p.y)})`,
      `地形: ${t ? t.name : '-'}  速度×${t ? t.speed : 0}`,
      `点数: ${st.points}（下一抽 ${drawCost(gachaState(st).n, balance)}）   兵力: ${shownN}/${p.cap}  兵种: ${UNIT_NAMES[p.team.unit] ?? '-'}   战力: ${Math.round(p.power)}`,
      `武将: ${p.team.generals.map(g => g.name).join('、')}   待安排: ${st.pendingGenerals.length ? st.pendingGenerals.map(e => e.general.name).join('、') : '无'}   自由池: ${st.freePool.length}`,
      `状态: ${status}${inv}  速度: ${Math.round(spd)}px/s  AI队伍: ${this.world.aiParties.length}/${balance.spawn.max_ai_teams}`,
      `缩放: ${this.world.cameras.main.zoom.toFixed(1)}  调试(F1): ${this.world.debugVision ? '开' : '关'}  存档: ${this.world.lastSaveAt === null ? '本局未存' : `${Math.round((now - this.world.lastSaveAt) / 1000)}s 前`}${this.world.saveDirty ? '（等待中）' : ''}`,
      this.cityLine(p),
      `FPS: ${Math.round(this.game.loop.actualFps)}`,
      ...(battle ? [battle] : [])
    ]);
    const logLines = st.battleLog.slice(0, 5).map(e => `[${(e.time / 1000).toFixed(0)}s] ${e.text}`);
    this.log.setText(logLines.length ? ['战报：', ...logLines] : '战报：暂无');
  }
}
