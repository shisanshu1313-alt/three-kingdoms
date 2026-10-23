/**
 * HUD 属性面板（Phaser 画，不用 DOM）：
 *   常显小面板（统帅 = 主角，姓名 + 四维；统率最高者另有其人时注明结算用的是谁），[属性 C] 按钮 / 点小面板 / C 键（input 动作 toggleStats）展开详情。
 *   数据：systems/statsView.js（纯 JS）；文字与布局：ui/statsText.js（纯 JS）。
 *   刷新：监听 EventBus TEAM_CHANGED（PartyModel.refresh 发出），只看玩家队；变化的值高亮 HIGHLIGHT_MS。
 *   不暂停游戏、不拦截面板以外的点击；详情半透明，横屏贴右、竖屏贴底。
 */
import { EventBus, EVENTS } from '../core/EventBus.js';
import { buildStatsView, flattenStats, changedKeys } from '../systems/statsView.js';
import { compactLines, detailLines, statsLayout } from './statsText.js';
import { button, FONT } from './widgets.js';

export const HIGHLIGHT_MS = 1500;
const COLOR = '#ffffff', TITLE = '#f1c40f', NOTE = '#ffb366', HL = '#ffe066', HL_BG = 0xb8860b;

export default class StatsHud {
  /** @param getParty () => 玩家 PartyModel；getCfg () => 战斗配置（WorldScene.field.cfg） */
  constructor(scene, { getParty, getCfg, balance }) {
    this.scene = scene; this.getParty = getParty; this.getCfg = getCfg; this.balance = balance;
    this.open = false; this.flat = null; this.hl = new Map(); // 键 → 高亮截止时间（scene.time.now）
    this.lastChanged = [];
    this.btn = button(scene, 0, 0, 74, 34, '属性 [C]', () => this.toggle(), { color: 0x2c5e3a, size: 14 }).setDepth(20);
    this.compact = scene.add.container(0, 0).setDepth(20);
    this.compactBg = scene.add.rectangle(0, 0, 10, 10, 0x000000, 0.6).setOrigin(0, 0).setStrokeStyle(1, 0xf1c40f, 0.7);
    this.compactBg.setInteractive({ useHandCursor: true }).on('pointerdown', (p, x, y, ev) => { ev?.stopPropagation?.(); this.toggle(); });
    this.compact.add(this.compactBg);
    this.detail = scene.add.container(0, 0).setDepth(20).setVisible(false);
    this.detailBg = scene.add.rectangle(0, 0, 10, 10, 0x000000, 0.62).setOrigin(0, 0).setStrokeStyle(1, 0xffffff, 0.5);
    this.detailBg.setInteractive().on('pointerdown', (p, x, y, ev) => { ev?.stopPropagation?.(); this.toggle(false); });
    this.detail.add(this.detailBg);
    this.cTexts = []; this.dTexts = [];

    const onTeam = ({ party }) => { if (party?.isPlayer && party === this.getParty()) this.refresh(); };
    EventBus.on(EVENTS.TEAM_CHANGED, onTeam);
    scene.events.once('shutdown', () => EventBus.off(EVENTS.TEAM_CHANGED, onTeam));
    this.layout();
    this.refresh();
  }

  toggle(on = !this.open) {
    this.open = on;
    this.detail.setVisible(on);
    this.btn.label.setText(on ? '收起 [C]' : '属性 [C]');
    if (on) this.render();
  }

  /** 重算数据；和上次比较，变化的键加入高亮 */
  refresh() {
    const party = this.getParty();
    if (!party) return;
    this.view = buildStatsView(party.team, this.balance, this.getCfg?.() ?? null);
    const flat = flattenStats(this.view);
    const changed = changedKeys(this.flat, flat);
    this.flat = flat;
    if (changed.size) {
      const until = this.scene.time.now + HIGHLIGHT_MS;
      for (const k of changed) this.hl.set(k, until);
      this.lastChanged = [...changed];
      this.scene.time.delayedCall(HIGHLIGHT_MS + 20, () => this.render());
    }
    this.render();
  }

  isHl(keys) { const now = this.scene.time.now; return keys.some(k => (this.hl.get(k) ?? 0) > now); }

  /** 按行画文字：变化的行 = 黄字 + 暗金底 */
  drawLines(container, pool, lines, x0, y0, width, font, pad) {
    for (const t of pool) { t.bg.destroy(); t.destroy(); }
    pool.length = 0;
    let y = y0 + pad;
    for (const l of lines) {
      if (!l.text) { y += Math.round(font * 1.45); continue; }
      const hl = this.isHl(l.keys);
      const t = this.scene.add.text(x0 + pad, y, l.text, { fontFamily: FONT, fontSize: `${font}px`, color: hl ? HL : l.title ? TITLE : l.note ? NOTE : COLOR, padding: { right: 4 }, wordWrap: { width: width - 2 * pad - 4, useAdvancedWrap: true } });
      t.bg = this.scene.add.rectangle(x0 + 2, y - 1, width - 4, t.height + 2, HL_BG, hl ? 0.45 : 0).setOrigin(0, 0);
      container.add([t.bg, t]);
      pool.push(t);
      y += Math.max(Math.round(font * 1.45), t.height + 2);
    }
    return y + pad - y0;
  }

  render() {
    if (!this.view || !this.L) return;
    const { compact: c, detail: d } = this.L;
    const ch = this.drawLines(this.compact, this.cTexts, compactLines(this.view), 0, 0, c.w, c.font, c.pad);
    this.compactBg.setSize(c.w, ch); this.compactBg.input?.hitArea.setTo(0, 0, c.w, ch);
    this.compactH = ch;
    if (!this.open) return;
    const dh = this.drawLines(this.detail, this.dTexts, detailLines(this.view), 0, 0, d.w, d.font, d.pad);
    this.detailBg.setSize(d.w, dh); this.detailBg.input?.hitArea.setTo(0, 0, d.w, dh);
    this.detailH = dh;
    const sh = this.scene.scale.height;
    // 竖屏贴底（bottom）；横屏从小面板下方开始，放不下就往上挪
    const top = c.y + ch + 8; // 小面板实际高度（3 或 4 行）
    const y = d.top === null ? Math.max(4, d.bottom - dh) : Math.max(4, Math.min(top, sh - 40 - dh));
    this.detail.setPosition(d.x, y);
  }

  layout() {
    const s = this.scene.scale;
    this.L = statsLayout({ width: s.width, height: s.height });
    const { btn, compact } = this.L;
    this.btn.setPosition(btn.x, btn.y);
    this.compact.setPosition(compact.x, compact.y);
    this.render();
  }

  /** 屏幕坐标是否落在面板 / 按钮上（WorldScene 点地面寻路前检查） */
  hits(px, py) {
    const inR = (x, y, w, h) => px >= x && px <= x + w && py >= y && py <= y + h;
    const { btn, compact } = this.L;
    if (inR(btn.x, btn.y, btn.w, btn.h) || inR(compact.x, compact.y, compact.w, this.compactH ?? 0)) return true;
    return this.open && inR(this.detail.x, this.detail.y, this.L.detail.w, this.detailH ?? 0);
  }

  /** 冒烟测试 / 调试读状态 */
  snapshot() {
    return { open: this.open, compact: this.cTexts.map(t => t.text), detail: this.open ? this.dTexts.map(t => t.text) : [], highlighted: [...this.hl].filter(([, u]) => u > this.scene.time.now).map(([k]) => k), lastChanged: this.lastChanged };
  }
}
