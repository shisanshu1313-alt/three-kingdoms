// 简易 UI 组件（占位色块风格）：按钮、面板、武将卡
import { ATTR_NAMES } from '../systems/gacha.js';

export const FONT = 'sans-serif';
export const TIER_COLORS = { S: 0xf1c40f, A: 0x9b59b6, B: 0x3498db, item: 0x2ecc71, attr_small: 0x95a5a6, attr_big: 0xe67e22, refund: 0x7f8c8d };
export const hex = c => '#' + c.toString(16).padStart(6, '0');

/** 按钮：返回 container，带 .setEnabled(bool)、.label；enabled=false 时灰色且不可点 */
export function button(scene, x, y, w, h, label, onClick, { enabled = true, color = 0x2c3e50, size = 15 } = {}) {
  const c = scene.add.container(x, y);
  const bg = scene.add.rectangle(0, 0, w, h, color).setStrokeStyle(2, 0xffffff, 0.8).setOrigin(0, 0);
  const t = scene.add.text(w / 2, h / 2, label, { fontFamily: FONT, fontSize: `${size}px`, color: '#ffffff' }).setOrigin(0.5);
  c.add([bg, t]);
  c.label = t; c.bg = bg; c.enabled = enabled;
  bg.setInteractive({ useHandCursor: true });
  bg.on('pointerover', () => c.enabled && bg.setFillStyle(0x3d5a80));
  bg.on('pointerout', () => bg.setFillStyle(c.enabled ? color : 0x555555));
  bg.on('pointerdown', (p, lx, ly, ev) => { ev?.stopPropagation?.(); if (c.enabled) onClick(); });
  c.setEnabled = (on) => { c.enabled = on; bg.setFillStyle(on ? color : 0x555555); t.setColor(on ? '#ffffff' : '#999999'); return c; };
  c.setEnabled(enabled);
  return c;
}

export function text(scene, x, y, str, size = 14, color = '#ffffff', extra = {}) {
  return scene.add.text(x, y, str, { fontFamily: FONT, fontSize: `${size}px`, color, ...extra });
}

/** 武将一行：色块(档位色) + 名字 + 四项属性 */
export function generalLine(general, { main = false } = {}) {
  const attrs = ['lead', 'str', 'int', 'cha'].map(a => `${ATTR_NAMES[a]}${general[a]}`).join(' ');
  return `${main ? '★' : '  '}${general.name}${general.tier ? `（${general.tier}）` : general.generic ? '（头目）' : ''}  ${attrs}`;
}

export function tierColor(general) {
  return TIER_COLORS[general?.tier] ?? 0x7f8c8d;
}
