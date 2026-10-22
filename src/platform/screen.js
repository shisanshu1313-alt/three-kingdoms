/**
 * 屏幕尺寸接口（平台无关）。游戏里取画布 / 窗口尺寸只能通过这里，不直接读 window。
 *   WebScreenAdapter：window.innerWidth / innerHeight（devicePixelRatio 交给 Phaser）
 *   WxScreenAdapter：微信 / 抖音小游戏（wx | tt）.getSystemInfoSync() 的 windowWidth / windowHeight / pixelRatio
 *   FixedScreenAdapter：固定尺寸（测试 / 无窗口环境）
 */
export class WebScreenAdapter {
  constructor(win = globalThis.window) { this.win = win; }
  size() { return { width: this.win.innerWidth, height: this.win.innerHeight, pixelRatio: this.win.devicePixelRatio || 1 }; }
  /** 是否由引擎跟随窗口缩放（网页：Phaser Scale.RESIZE） */
  get resizable() { return true; }
}

export class WxScreenAdapter {
  constructor(api) { this.api = api; }
  size() { const i = this.api.getSystemInfoSync(); return { width: i.windowWidth, height: i.windowHeight, pixelRatio: i.pixelRatio || 1 }; }
  get resizable() { return false; }
}

export class FixedScreenAdapter {
  constructor(width = 1280, height = 720, pixelRatio = 1) { this.s = { width, height, pixelRatio }; }
  size() { return { ...this.s }; }
  get resizable() { return false; }
}

export function createDefaultScreen() {
  if (typeof globalThis.window !== 'undefined' && globalThis.window.innerWidth) return new WebScreenAdapter();
  return new FixedScreenAdapter();
}

let current = null;
export function getScreen() { return current || (current = createDefaultScreen()); }
export function setScreen(adapter) { current = adapter; }

/**
 * Phaser 的 scale 配置：mode 用字符串，由入口换成 Phaser 常量（这里不 import Phaser）。
 * 网页 = 'RESIZE'（铺满窗口，跟随窗口变化，与以前相同）；小游戏 = 'NONE'（固定为屏幕尺寸）。
 */
export function scaleConfig(screen = getScreen()) {
  const { width, height } = screen.size();
  return { mode: screen.resizable ? 'RESIZE' : 'NONE', width, height };
}
