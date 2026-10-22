import Phaser from 'phaser';
import { balance } from '../data/index.js';
import { MAP_SEED } from '../config.js';
import { loadSave, clearSave } from '../systems/save.js';
import { button, text } from '../ui/widgets.js';

const fmtTime = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };

/**
 * 标题菜单（有存档时出现）：继续游戏 / 新游戏（新游戏需确认，会删除存档）。
 * 存档损坏 / 不兼容：显示原因，只提供新游戏；绝不崩溃。
 * 键盘：Enter 或 1 = 继续；N 或 2 = 新游戏；确认框 Y = 确定、N/Esc = 取消。
 */
export default class TitleScene extends Phaser.Scene {
  constructor() { super('Title'); }

  init(data) { this.forcedError = data?.error ?? null; this.confirming = false; }

  create() {
    this.result = this.forcedError ? { ok: false, code: 'corrupt', message: this.forcedError } : loadSave({ balance, mapSeed: MAP_SEED });
    this.root = this.add.container(0, 0);
    this.input.keyboard.on('keydown', e => this.onKey(e.key));
    this.render();
    this.scale.on('resize', this.render, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.render, this));
  }

  onKey(k) {
    if (this.confirming) {
      if (k === 'y' || k === 'Y' || k === 'Enter') this.newGame();
      if (k === 'n' || k === 'N' || k === 'Escape') { this.confirming = false; this.render(); }
      return;
    }
    if ((k === 'Enter' || k === '1') && this.result.ok) this.continueGame();
    if (k === 'n' || k === 'N' || k === '2') { this.confirming = true; this.render(); }
  }

  continueGame() { this.scene.start('World', { save: this.result.save, warnings: this.result.warnings }); }

  newGame() { clearSave(); this.scene.start('World', {}); }

  render() {
    this.root.removeAll(true);
    const add = o => { this.root.add(o); return o; };
    const { width: w, height: h } = this.scale, cx = w / 2;
    add(this.add.rectangle(0, 0, w, h, 0x10131a).setOrigin(0));
    add(text(this, cx, h * 0.22, '三国 · 群雄逐鹿', 40, '#f1c40f').setOrigin(0.5));
    add(text(this, cx, h * 0.22 + 44, `像素开放世界原型 · 数值 v${balance._meta?.version ?? '?'}`, 14, '#999999').setOrigin(0.5));
    const r = this.result, by = h * 0.5;
    if (this.confirming) {
      add(this.add.rectangle(cx - 220, by - 30, 440, 150, 0x2a1f1f).setOrigin(0).setStrokeStyle(2, 0xe74c3c));
      add(text(this, cx, by, '确定开始新游戏？', 20, '#ffffff').setOrigin(0.5));
      add(text(this, cx, by + 28, '现有存档将被删除，无法恢复。', 14, '#ffaaaa').setOrigin(0.5));
      add(button(this, cx - 200, by + 60, 180, 40, '确定 [Y]', () => this.newGame(), { color: 0x7f3b3b }));
      add(button(this, cx + 20, by + 60, 180, 40, '取消 [N]', () => { this.confirming = false; this.render(); }));
      return;
    }
    if (r.ok) {
      const s = r.save, p = s.player.team;
      add(text(this, cx, by - 40, `存档：${new Date(s.savedAt).toLocaleString('zh-CN')} · 游戏时长 ${fmtTime(s.gameTimeMs)}`, 14, '#cccccc').setOrigin(0.5));
      add(text(this, cx, by - 18, `点数 ${s.state.points} · 兵 ${p.soldiers} · 武将 ${p.generals.map(g => g.name).join('、')}`, 14, '#cccccc').setOrigin(0.5));
      for (const [i, wmsg] of (r.warnings || []).entries()) add(text(this, cx, by + 4 + i * 18, wmsg, 13, '#ffdd55').setOrigin(0.5));
      this.btnContinue = add(button(this, cx - 120, by + 40, 240, 46, '继续游戏 [Enter]', () => this.continueGame(), { color: 0x8e5a00, size: 18 }));
      this.btnNew = add(button(this, cx - 120, by + 100, 240, 46, '新游戏 [N]', () => { this.confirming = true; this.render(); }, { size: 18 }));
    } else {
      add(text(this, cx, by - 20, `无法读取存档：${r.message}`, 16, '#ff8888', { wordWrap: { width: Math.min(700, w - 40) }, align: 'center' }).setOrigin(0.5));
      add(text(this, cx, by + 8, '可以开始新游戏（会删除这个存档）。', 14, '#cccccc').setOrigin(0.5));
      this.btnContinue = null;
      this.btnNew = add(button(this, cx - 120, by + 50, 240, 46, '新游戏 [N]', () => { this.confirming = true; this.render(); }, { size: 18 }));
    }
  }
}
