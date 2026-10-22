import Phaser from 'phaser';
import { MINIMAP_SIZE, TILE_SIZE } from '../config.js';
import { EventBus, EVENTS } from '../core/EventBus.js';
import { balance } from '../data/index.js';

// UI 覆盖层：坐标、地形、FPS、小地图边框、碰撞提示
export default class UIScene extends Phaser.Scene {
  constructor() { super('UI'); }

  create() {
    this.world = this.scene.get('World');
    const style = { fontFamily: 'monospace', fontSize: '14px', color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.55)', padding: { x: 8, y: 6 } };
    this.info = this.add.text(10, 10, '', style).setScrollFactor(0);
    this.help = this.add.text(10, 0, 'WASD/方向键 移动 · 左键点击 寻路移动 · 滚轮 缩放 · 悬停队伍看详情 · F1 调试（视野/路径）', { ...style, fontSize: '12px' }).setScrollFactor(0);

    this.minimapFrame = this.add.graphics();
    this.toasts = [];

    this.layout();
    this.scale.on('resize', () => this.layout());

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
      },
      [EVENTS.AI_STATE]: ({ party, to, targetId }) => {
        if (targetId === 'player') this.toast(to === 'chase' ? `${party.name} 正在追击你！` : `${party.name} 望风而逃`, '#ffbb66', 14);
      }
    };
    for (const [ev, fn] of Object.entries(handlers)) EventBus.on(ev, fn);
    this.events.once('shutdown', () => { for (const [ev, fn] of Object.entries(handlers)) EventBus.off(ev, fn); });
  }

  layout() {
    const w = this.scale.width, h = this.scale.height;
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
    const st = this.world.state, now = this.world.time.now;
    const inv = p.isInvincible(now) ? `  无敌${((p.invincibleUntil - now) / 1000).toFixed(1)}s` : '';
    const status = p.inBattle ? '交战中' : (p.path ? '行军' : '待命');
    const t = this.world.tileAt(p.x, p.y);
    const tx = Math.floor(p.x / TILE_SIZE), ty = Math.floor(p.y / TILE_SIZE);
    this.info.setText([
      `坐标: (${tx}, ${ty})  像素: (${Math.round(p.x)}, ${Math.round(p.y)})`,
      `地形: ${t ? t.name : '-'}  速度×${t ? t.speed : 0}`,
      `积分: ${st.points}   兵力: ${p.soldiers}/${p.cap}   战力: ${Math.round(p.power)}`,
      `武将: ${p.team.generals.map(g => g.name).join('、')}   待处理俘虏: ${st.pendingCaptives.length ? st.pendingCaptives.map(g => g.name).join('、') : '无'}   自由池: ${st.freePool.length}`,
      `状态: ${status}${inv}  速度: ${Math.round(p.moveSpeed())}px/s  AI队伍: ${this.world.aiParties.length}/${balance.spawn.max_ai_teams}`,
      `缩放: ${this.world.cameras.main.zoom.toFixed(1)}  调试(F1): ${this.world.debugVision ? '开' : '关'}`,
      `FPS: ${Math.round(this.game.loop.actualFps)}`
    ]);
    const logLines = st.battleLog.slice(0, 5).map(e => `[${(e.time / 1000).toFixed(0)}s] ${e.text}`);
    this.log.setText(logLines.length ? ['战报：', ...logLines] : '战报：暂无');
  }
}
