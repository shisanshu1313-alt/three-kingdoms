/**
 * v0.5 侦察显示（units.scouting，纯函数）：
 *   ≤ 视野 300 px：兵种、精确兵数、战力对比色（按克制后的有效战力：绿 ≥ 1.2 倍 / 黄 0.8–1.2 / 红 < 0.8）、克制箭头（↑ 我克他 / ↓ 他克我）
 *   ≤ 侦察 500 px（斥候旗 +200）：兵种、兵数约数（取整到 10）
 *   更远：只显示势力色，不显示兵种
 */
export const SCOUT_COLORS = { good: '#66ee66', even: '#ffdd55', bad: '#ff6666', scout: '#dddddd', far: '#bbbbbb' };

export function scoutRange(team, balance) {
  const S = balance.v05?.units?.scouting ?? { vision_px: balance.ai.vision_px, scout_px: balance.ai.vision_px };
  const extra = (team.items || []).reduce((s, id) => s + (balance.items.find(i => i.id === id)?.effect?.scout_px ?? 0), 0);
  return { vision: S.vision_px, scout: S.scout_px + extra };
}

/** me / them = { unit, power, soldiers }；mult = 本章克制倍率（含群雄模式加成） */
export function scoutInfo({ me, them, dist, range, counters, mult = 1 }) {
  if (dist <= range.vision) {
    const k = (a, b) => (counters[a.unit] === b.unit ? mult : 1);
    const ratio = (me.power * k(me, them)) / Math.max(1e-9, them.power * k(them, me));
    const color = ratio >= 1.2 ? SCOUT_COLORS.good : ratio >= 0.8 ? SCOUT_COLORS.even : SCOUT_COLORS.bad;
    const arrow = counters[me.unit] === them.unit ? '↑' : counters[them.unit] === me.unit ? '↓' : '';
    return { tier: 'vision', showUnit: true, soldiers: String(them.soldiers), color, arrow, ratio };
  }
  if (dist <= range.scout) return { tier: 'scout', showUnit: true, soldiers: `约${Math.round(them.soldiers / 10) * 10}`, color: SCOUT_COLORS.scout, arrow: '' };
  return { tier: 'far', showUnit: false, soldiers: '', color: SCOUT_COLORS.far, arrow: '' };
}
