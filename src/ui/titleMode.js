// 标题页模式（纯函数，测试用）：QA-10 / 策划 —— 第一次打开（没有存档、没有局外解锁、没有旧档提示）也先出标题页，
// 只放「开始」按钮 + 一行操作说明；有存档 / 解锁时保持原来的标题页（继续 / 放弃 / 新一局选项）。
export const FIRST_RUN_CONTROLS = '操作：WASD / 方向键移动，或点按地面寻路 · 撞上敌军即交战，开走即脱离 · G 抽卡 · P 暂停';

/** result = loadSave 结果（没有进行中的一局时为 null）；返回 'first' | 'run' | 'error' | 'options' */
export function titleMode({ result, legacy, unlocked }) {
  if (result?.ok) return 'run';
  if (result && !result.ok) return 'error';
  if (!legacy && !(unlocked?.length)) return 'first';
  return 'options';
}

/** 「开始」按钮 / 文字宽度：竖屏约 380 宽也放得下（两边各留 16 px） */
export function firstRunLayout(w, h) {
  const btnW = Math.min(240, w - 32), wrap = Math.min(640, w - 32);
  return { btnW, btnH: 52, wrap, titleSize: w < 420 ? 34 : 40, by: Math.round(h * 0.5) };
}
