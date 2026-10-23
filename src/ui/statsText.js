/**
 * HUD 属性面板的文字与布局（纯 JS，无 Phaser；单测见 tests/statsView.test.js）。
 *   compactLines(view) / detailLines(view) → [{ text, keys }]：keys = 这一行显示的 flattenStats 键，变化时整行高亮
 *   statsLayout({ width, height })          → 面板位置 / 字号（横屏、竖屏、窄屏）
 * 屏幕尺寸来自 platform/screen.js（Phaser 的 scale 由 scaleConfig(getScreen()) 设定，UIScene 传入 this.scale 的宽高）。
 */
import { fmtPct, ATTRS } from '../systems/statsView.js';
import { ATTR_NAMES } from '../systems/gacha.js';
import { UNIT_NAMES, UNIT_FULL_NAMES } from '../systems/units.js';
import { MINIMAP_SIZE } from '../config.js';

const attrCells = (g, list = ATTRS) => list.map(a => `${ATTR_NAMES[a]} ${g[a]}`).join('  ');
const plus = x => (x ? ` + ${fmtPct(x)}` : '');

/** 常显小面板：主角四维（两行）+ 主将姓名与统率 */
export function compactLines(v) {
  const h = v.hero;
  return [
    { text: h ? `主角  ${attrCells(h, ['lead', 'str'])}` : '主角  -', keys: ['hero.lead', 'hero.str'] },
    { text: h ? `      ${attrCells(h, ['int', 'cha'])}` : '', keys: ['hero.int', 'hero.cha'] },
    { text: v.main ? `主将  ${v.main.name}  统率 ${v.main.lead}` : '主将  -', keys: ['main.id', 'main.lead'] }
  ];
}

/** 详情：每名武将四维 + 派生值（全部来自 buildStatsView，即现有公式与配置） */
export function detailLines(v) {
  const L = [];
  L.push({ text: '队伍属性（★ = 主将，统率最高者）', keys: [], title: true });
  for (const g of v.generals) {
    const tag = g.tier ? `（${g.tier}）` : g.generic ? '（头目）' : '';
    const aff = g.affinity ? `  擅${UNIT_NAMES[g.affinity]}` : '';
    L.push({ text: `${g.isMain ? '★' : '・'}${g.name}${tag}  ${attrCells(g)}${aff}`, keys: ATTRS.map(a => `gen.${g.id}.${a}`).concat(g.isMain ? ['main.id'] : []) });
  }
  const c = v.cap;
  L.push({ text: `兵种 ${UNIT_FULL_NAMES[v.unit] ?? '-'}   兵力 ${v.soldiers}/${c.total}`, keys: ['unit', 'cap'] });
  L.push({ text: `兵力上限 ${c.total} = ${c.base} + ${c.perLead}×Σ统率 ${c.sumLead}${c.items ? ` + 物品 ${c.items}` : ''}`, keys: ['cap'] });
  const p = v.power;
  L.push({ text: `战力 ${Math.round(p.total)}   倍率 ×${p.mult.toFixed(3)}（主将统率 ${fmtPct(p.lead)} · Σ武力 ${fmtPct(p.str)}${plus(p.items) ? ` · 物品 ${fmtPct(p.items)}` : ''}${p.affinity ? ` · 擅长兵种 ${fmtPct(p.affinity)}` : ''}）`, keys: ['powerMult'] });
  const r = v.lossRed;
  L.push({ text: `智力减伤 ${fmtPct(r.int)}（最高智力 ${r.maxInt} × ${fmtPct(r.k)}，上限 ${fmtPct(r.intCap)}）`, keys: ['intRed'] });
  L.push({ text: `总损兵减免 ${fmtPct(r.total)}（智力${plus(r.items) ? ` + 物品 ${fmtPct(r.items)}` : ''}${r.unit ? ` + 兵种 ${fmtPct(r.unit)}` : ''}，上限 ${fmtPct(r.totalCap)}）`, keys: ['lossRed'] });
  const q = v.recruit;
  L.push({ text: `魅力收编率 ${fmtPct(q.total)}（${fmtPct(q.base)} + 最高魅力 ${q.maxCha} × ${fmtPct(q.perCha)}${q.items ? ` + 物品 ${fmtPct(q.items)}` : ''}，上限 ${fmtPct(q.max)}）`, keys: ['recruit'] });
  const s = v.speed;
  if (s.total !== null) L.push({ text: `统率速度 ×${s.leadMult.toFixed(2)}   行军速度 ${Math.round(s.total)} px/s（不含地形）`, keys: ['leadMult', 'unit'] });
  const a = v.affinity;
  L.push({ text: a.main ? `擅长兵种：主将擅${UNIT_FULL_NAMES[a.main]}，${a.active ? `已匹配 战力倍率 +${fmtPct(a.bonus)}` : `当前${UNIT_FULL_NAMES[v.unit] ?? '-'}，未匹配（+${fmtPct(a.bonus)}）`}` : '擅长兵种：主将无', keys: ['affinity'] });
  return L;
}

/**
 * 布局：小地图（右上，MINIMAP_SIZE）下方一行是 [抽卡][属性 C] 按钮，小面板在按钮下方，与小地图左对齐。
 * 详情：横屏在小面板下方、靠右；竖屏 / 窄屏铺满宽度、贴底（在战报上方），字号更小。
 */
export function statsLayout({ width: w, height: h }) {
  const portrait = h > w, narrow = portrait || w < 760;
  const colX = w - MINIMAP_SIZE - 10;
  const btn = { x: colX + 126, y: MINIMAP_SIZE + 20, w: MINIMAP_SIZE - 126, h: 34 };
  const compact = { x: colX, y: btn.y + btn.h + 8, w: MINIMAP_SIZE, font: narrow ? 11 : 13, pad: 6 };
  const compactH = 3 * Math.round(compact.font * 1.45) + 2 * compact.pad;
  const detail = narrow
    ? { x: 10, w: w - 20, bottom: h - 130, top: null, font: 11, pad: 6 }
    : { x: null, right: w - 10, w: Math.min(430, w - 20), top: compact.y + compactH + 8, bottom: null, font: 13, pad: 8 };
  if (detail.x === null) detail.x = detail.right - detail.w;
  return { portrait, narrow, btn, compact: { ...compact, h: compactH }, detail };
}
