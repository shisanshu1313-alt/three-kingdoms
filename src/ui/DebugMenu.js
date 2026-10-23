/**
 * F2 调试菜单（只在开发模式：UIScene 里 if (import.meta.env.DEV) 动态 import 本文件；正式构建里整段不存在）。
 * Phaser 画的面板（不用 DOM）：1 点数 +N、2 立即主城 / 触发迁都、3 填满地图队伍（触发 T2 撤下过弱黄巾队）；Esc / F2 关闭。
 */
import { ACTIONS } from '../platform/input.js';
import { applyDevHomeCity, applyDevFillTeams, fillTeamsText } from '../systems/devTools.js';

export default class DebugMenu {
  constructor(ui, act, { points, maxTeams }) {
    this.ui = ui; this.points = points; this.maxTeams = maxTeams; this.open = false;
    // QA-05：菜单打开时暂停大地图；QA-11：选 1 后菜单不关，可连按；选 2 / 3 后自动关闭；QA-06：有弹窗时不开、弹窗打开时自动关
    const lines = ['【调试菜单 F2】（仅开发模式 · 打开时游戏暂停）', `1  点数 +${points}（菜单不关，可连按）`, '2  立即获得主城 / 已有主城时触发迁都（Y / N）（选后关闭）', `3  填满地图队伍（${maxTeams} 队）→ 触发 T2 撤下过弱黄巾队（选后关闭）`, 'Esc / F2  关闭'];
    this.bg = ui.add.rectangle(0, 0, 520, 22 * lines.length + 20, 0x101830, 0.92).setOrigin(0.5).setStrokeStyle(2, 0x88ccff).setScrollFactor(0).setDepth(1000);
    this.text = ui.add.text(0, 0, lines.join('\n'), { fontFamily: 'sans-serif', fontSize: '15px', color: '#cfe8ff', lineSpacing: 6 }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
    this.setVisible(false);
    act.on(ACTIONS.DEBUG_POINTS, () => { this.toggle(); return true; });
    act.on(ACTIONS.CHOOSE, ({ n }) => { if (!this.open) return; this.choose(n); return true; });
    act.on(ACTIONS.CANCEL, () => { if (!this.open) return; this.toggle(false); return true; });
    const onUpdate = () => { if (this.open && ui.modalOpen()) this.toggle(false); };
    ui.events.on('update', onUpdate);
    ui.events.once('shutdown', () => ui.events.off('update', onUpdate));
  }
  setVisible(v) { this.bg.setVisible(v); this.text.setVisible(v); }
  toggle(on = !this.open) {
    if (on && this.ui.modalOpen()) on = false; // 弹窗开着时不开菜单（否则菜单留在弹窗下面成残影）
    this.open = on;
    const ui = this.ui;
    if (on && !ui.scene.isPaused('World')) { ui.scene.pause('World'); this.pausedWorld = true; }
    if (!on && this.pausedWorld) { this.pausedWorld = false; if (!ui.modalOpen() && !ui.pauseUi) ui.scene.resume('World'); }
    const { width: w, height: h } = this.ui.scale;
    this.bg.setPosition(w / 2, h / 2); this.text.setPosition(w / 2, h / 2);
    this.setVisible(on);
    return on;
  }
  choose(n) {
    const world = this.ui.world;
    if (n === 1) { world.debugGrantPoints(this.points); this.ui.toast(`【调试】点数 +${this.points}（现在 ${world.state.points}）`, '#88ccff', 16); return; }
    else if (n === 2) this.ui.toast(applyDevHomeCity(world), '#88ccff', 16);
    else if (n === 3) this.ui.toast(fillTeamsText(applyDevFillTeams(world, this.maxTeams)), '#88ccff', 16);
    else return;
    this.toggle(false);
  }
}
