// 面板设计尺寸：横屏 900×580、4 张卡一排；窄屏（屏宽 < 横屏面板 + 边距）换成 458×880、2×2 排卡（QA-16 / SJ-06）。
// 再用镜头缩放整体塞进屏幕（只缩小不放大），所有卡、按钮都完整可见、可点。
export const PANEL_WIDE = { W: 900, H: 580, cols: 4 }, PANEL_NARROW = { W: 458, H: 880, cols: 2 };
const MARGIN = 8;
/** 按屏幕尺寸选布局 + 缩放（纯函数，测试用）。返回 { W, H, cols, s, vw, vh, ox, oy }（vw/vh = 缩放后的虚拟屏幕） */
export function gachaLayout(width, height) {
  const L = width >= PANEL_WIDE.W + 2 * MARGIN || width >= height ? PANEL_WIDE : PANEL_NARROW;
  const s = Math.min(1, (width - 2 * MARGIN) / L.W, (height - 2 * MARGIN) / L.H);
  const vw = width / s, vh = height / s;
  return { ...L, s, vw, vh, ox: Math.round((vw - L.W) / 2), oy: Math.round((vh - L.H) / 2) };
}
