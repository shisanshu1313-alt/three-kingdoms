/**
 * 应用生命周期接口（平台无关）：游戏只关心“要被切到后台 / 关闭了，赶紧存档”。
 *   onHide(cb) → 返回取消订阅函数
 * 实现：
 *   - WebLifecycleAdapter：visibilitychange(hidden) / pagehide / beforeunload
 *   - NullLifecycleAdapter：单测 / 不支持的环境
 *   - 以后：微信/抖音 wx.onHide / tt.onHide；iOS 原生 applicationWillResignActive
 */

export class WebLifecycleAdapter {
  onHide(cb) {
    const doc = globalThis.document, win = globalThis.window;
    if (!doc || !win) return () => {};
    const vis = () => { if (doc.visibilityState === 'hidden') cb('hidden'); };
    const hide = () => cb('pagehide');
    const unload = () => cb('beforeunload');
    doc.addEventListener('visibilitychange', vis);
    win.addEventListener('pagehide', hide);
    win.addEventListener('beforeunload', unload);
    return () => {
      doc.removeEventListener('visibilitychange', vis);
      win.removeEventListener('pagehide', hide);
      win.removeEventListener('beforeunload', unload);
    };
  }
}

export class NullLifecycleAdapter { onHide() { return () => {}; } }

/** 示例（未启用）：微信 / 抖音小游戏 */
export class WxLifecycleAdapter {
  constructor(api) { this.api = api; }
  onHide(cb) { const fn = () => cb('hidden'); this.api.onHide(fn); return () => this.api.offHide?.(fn); }
}

let current = null;
export function getLifecycle() {
  return (current ??= (globalThis.document && globalThis.window ? new WebLifecycleAdapter() : new NullLifecycleAdapter()));
}
export function setLifecycle(adapter) { current = adapter; }
