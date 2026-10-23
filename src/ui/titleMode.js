// 标题页模式（纯函数，测试用）：QA-10 / 策划 —— 第一次打开（没有存档、没有局外解锁、没有旧档提示）也先出标题页，
// 只放「开始」按钮 + 一行操作说明；有存档 / 解锁时保持原来的标题页（继续 / 放弃 / 新一局选项）。
// 策划 2026-10-23：点过「开始」进过一局（meta.has_started_run，见 systems/meta.js hasStartedRun）就不再是第一次打开，
// 之后标题页是正常版（不带操作说明那行），正常版上有一个小入口「操作说明 [H]」打开说明面板。
export const FIRST_RUN_CONTROLS = '操作：WASD / 方向键移动，或点按地面寻路 · 撞上敌军即交战，开走即脱离 · G 抽卡 · P 暂停';

/** 正常版标题页「操作说明」面板的内容（一行一条；竖屏 ~380 宽按 controlsPanelLayout 自动换行） */
export const CONTROLS_HELP = [
  '移动：WASD / 方向键，或点按地面寻路',
  '交战：撞上敌军即交战，开走即脱离',
  'G 抽卡（F 刷新 4 张）· H 主城 · E 替换副将',
  'B 城池整编 · C 属性详情 · P 暂停'
];

/** result = loadSave 结果（没有进行中的一局时为 null）；started = hasStartedRun(...)；返回 'first' | 'run' | 'error' | 'options' */
export function titleMode({ result, legacy, unlocked, started = false }) {
  if (result?.ok) return 'run';
  if (result && !result.ok) return 'error';
  if (!started && !legacy && !(unlocked?.length)) return 'first';
  return 'options';
}

/** 「开始」按钮 / 文字宽度：竖屏约 380 宽也放得下（两边各留 16 px） */
export function firstRunLayout(w, h) {
  const btnW = Math.min(240, w - 32), wrap = Math.min(640, w - 32);
  return { btnW, btnH: 52, wrap, titleSize: w < 420 ? 34 : 40, by: Math.round(h * 0.5) };
}

/** 正常版标题页：底部「操作说明」小按钮 + 说明面板（竖屏 ~380 宽：面板两边各留 12 px） */
export function controlsPanelLayout(w, h) {
  // 面板高度按实际排好的行定（TitleScene.renderHelp），这里给宽度 / 行距 / 换行宽度和入口位置
  const pw = Math.min(480, w - 24), lineH = 26;
  const entryW = Math.min(180, w - 32), entryH = 34;
  return { pw, px: Math.round((w - pw) / 2), lineH, wrap: pw - 32,
    entryW, entryH, entryX: Math.round((w - entryW) / 2), entryY: Math.round(h - entryH - 16) };
}
