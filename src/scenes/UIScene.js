import { createSceneInput, ACTIONS, DEFAULT_BINDINGS, KEY_CODES, withKeys } from '../platform/input.js';
import Phaser from 'phaser';
import { MINIMAP_SIZE, TILE_SIZE, MAP_SEED } from '../config.js';
import { loadSave } from '../systems/save.js';
import { getStorage } from '../platform/storage.js';
import { EventBus, EVENTS } from '../core/EventBus.js';
import { balance } from '../data/index.js';
import { button } from '../ui/widgets.js';
import { pullCost } from '../systems/gacha.js';
import { shownSoldiers, moraleOf, inCombat, vmaxOf } from '../systems/melee.js';
import { UNIT_NAMES } from '../systems/units.js';

const UI_CFG = balance.gacha_ui ?? {};
const DEBUG_POINTS = 200;

// UI 覆盖层：坐标、地形、FPS、小地图边框、碰撞提示
export default class UIScene extends Phaser.Scene {
  constructor() { super('UI'); }

  create(data = {}) {
    this.world = this.scene.get('World');
    const style = { fontFamily: 'monospace', fontSize: '14px', color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.55)', padding: { x: 8, y: 6 } };
    this.info = this.add.text(10, 10, '', style).setScrollFactor(0);
    this.help = this.add.text(10, 0, 'WASD/方向键 移动 · 左键点击 寻路移动 · 滚轮 缩放 · 悬停队伍看详情 · G 抽卡 · F5 存档 · F9 读档 · F1 调试（视野/路径）' + (import.meta.env.DEV ? ' · F2 调试加点' : ''), { ...style, fontSize: '12px' }).setScrollFactor(0);

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
      capture: import.meta.env.DEV ? ['F2', 'F5', 'F9'] : ['F5', 'F9']
    });
    act.on(ACTIONS.OPEN_GACHA, () => this.openGacha());
    act.on(ACTIONS.SAVE, () => this.manualSave());
    act.on(ACTIONS.LOAD, () => this.manualLoad());
    if (import.meta.env.DEV) { // 只在开发模式（npm run dev）注册；生产构建里整段被移除
      act.on(ACTIONS.DEBUG_POINTS, () => { this.world.debugGrantPoints(DEBUG_POINTS); this.toast(`【调试】点数 +${DEBUG_POINTS}`, '#88ccff', 14); });
    }
    const onSaved = ({ reason }) => { if (reason === 'manual') this.toast('已存档', '#aaffaa', 16); };
    this.game.events.on('game-saved', onSaved);
    this.events.once('shutdown', () => this.game.events.off('game-saved', onSaved));
    if (data.loaded) this.time.delayedCall(100, () => { this.toast('已读取存档', '#aaffaa', 16); this.reopenPendingChoice(); });
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

  modalOpen() { return this.scene.isActive('Gacha') || this.scene.isPaused('Gacha') || this.scene.isActive('Roster'); }

  /** 存档决定 1：读档后若有没做完的选择（抽卡选武将 / 物品栏满 / 满编安排），重新弹出对应窗口 */
  reopenPendingChoice() {
    if (this.modalOpen()) return;
    const st = this.world.state;
    if (st.gachaPending) return this.openGacha({ force: true });
    if (st.pendingGenerals.length) this.openRoster();
  }

  /** gacha_ui.allowed_when：不在战斗中且没有待安排武将（有则先弹出名册窗口） */
  openGacha({ force = false } = {}) {
    if (this.modalOpen()) return;
    if (!force && this.world.player.inBattle) return this.toast('战斗中不能抽卡', '#ff8888', 15);
    if (this.world.state.pendingGenerals.length && !this.world.state.gachaPending) return this.openRoster();
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
    this.time.delayedCall(0, () => {
      if (this.world.state.pendingGenerals.length && !this.modalOpen()) return this.openRoster();
      if (!this.modalOpen() && this.scene.isPaused('World')) this.scene.resume('World');
    });
  }

  hitsHud(pointer) {
    const b = this.gachaBtn;
    return b && pointer.x >= b.x && pointer.x <= b.x + 120 && pointer.y >= b.y && pointer.y <= b.y + 34;
  }

  layout() {
    const w = this.scale.width, h = this.scale.height;
    if (this.gachaBtn) this.gachaBtn.setPosition(w - MINIMAP_SIZE - 10, MINIMAP_SIZE + 20);
    this.help.setPosition(10, h - 30);
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
    this.info.setText([
      `坐标: (${tx}, ${ty})  像素: (${Math.round(p.x)}, ${Math.round(p.y)})`,
      `地形: ${t ? t.name : '-'}  速度×${t ? t.speed : 0}`,
      `点数: ${st.points}（下一抽 ${pullCost(st.gachaDraws, balance.gacha)}）   兵力: ${shownN}/${p.cap}  兵种: ${UNIT_NAMES[p.team.unit] ?? '-'}   战力: ${Math.round(p.power)}`,
      `武将: ${p.team.generals.map(g => g.name).join('、')}   待安排: ${st.pendingGenerals.length ? st.pendingGenerals.map(e => e.general.name).join('、') : '无'}   自由池: ${st.freePool.length}`,
      `状态: ${status}${inv}  速度: ${Math.round(spd)}px/s  AI队伍: ${this.world.aiParties.length}/${balance.spawn.max_ai_teams}`,
      `缩放: ${this.world.cameras.main.zoom.toFixed(1)}  调试(F1): ${this.world.debugVision ? '开' : '关'}  存档: ${this.world.lastSaveAt === null ? '本局未存' : `${Math.round((now - this.world.lastSaveAt) / 1000)}s 前`}${this.world.saveDirty ? '（等待中）' : ''}`,
      `FPS: ${Math.round(this.game.loop.actualFps)}`,
      ...(battle ? [battle] : [])
    ]);
    const logLines = st.battleLog.slice(0, 5).map(e => `[${(e.time / 1000).toFixed(0)}s] ${e.text}`);
    this.log.setText(logLines.length ? ['战报：', ...logLines] : '战报：暂无');
  }
}
