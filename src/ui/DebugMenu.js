/**
 * F2 调试菜单（只在开发模式：UIScene 里 if (import.meta.env.DEV) 动态 import 本文件；正式构建里整段不存在）。
 * Phaser 画的面板（不用 DOM）：1 点数 +N、2 立即主城 / 触发迁都、3 填满地图队伍（触发 T2 撤下过弱黄巾队）；Esc / F2 关闭。
 */
import { ACTIONS } from '../platform/input.js';
import { applyDevHomeCity, applyDevFillTeams } from '../systems/devTools.js';

export default class DebugMenu {
  constructor(ui, act, { points, maxTeams }) {
    this.ui = ui; this.points = points; this.maxTeams = maxTeams; this.open = false;
    const lines = ['【调试菜单 F2】（仅开发模式）', `1  点数 +${points}`, '2  立即获得主城 / 已有主城时触发迁都（Y / N）', `3  填满地图队伍（${maxTeams} 队）→ 触发 T2 撤下过弱黄巾队`, 'Esc / F2  关闭'];
    this.bg = ui.add.rectangle(0, 0, 440, 22 * lines.length + 20, 0x101830, 0.92).setOrigin(0.5).setStrokeStyle(2, 0x88ccff).setScrollFactor(0).setDepth(1000);
    this.text = ui.add.text(0, 0, lines.join('\n'), { fontFamily: 'sans-serif', fontSize: '15px', color: '#cfe8ff', lineSpacing: 6 }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
    this.setVisible(false);
    act.on(ACTIONS.DEBUG_POINTS, () => { this.toggle(); return true; });
    act.on(ACTIONS.CHOOSE, ({ n }) => { if (!this.open) return; this.choose(n); return true; });
    act.on(ACTIONS.CANCEL, () => { if (!this.open) return; this.toggle(false); return true; });
  }
  setVisible(v) { this.bg.setVisible(v); this.text.setVisible(v); }
  toggle(on = !this.open) {
    this.open = on;
    const { width: w, height: h } = this.ui.scale;
    this.bg.setPosition(w / 2, h / 2); this.text.setPosition(w / 2, h / 2);
    this.setVisible(on);
    return on;
  }
  choose(n) {
    const world = this.ui.world;
    if (n === 1) { world.debugGrantPoints(this.points); this.ui.toast(`【调试】点数 +${this.points}`, '#88ccff', 14); }
    else if (n === 2) this.ui.toast(applyDevHomeCity(world), '#88ccff', 14);
    else if (n === 3) {
      const r = applyDevFillTeams(world, this.maxTeams);
      this.ui.toast(`【调试】队伍 ${r.total}/${r.max}（新刷 ${r.added}）；T2 撤下过弱黄巾队 ${r.removed} 支`, '#88ccff', 14);
    } else return;
    this.toggle(false);
  }
}
