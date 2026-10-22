/**
 * 存储接口（平台无关）。游戏里只能通过这里读写持久化数据，其它文件不许直接用 localStorage。
 *
 * 接口：{ get(key) → string | null, set(key, value: string) → void, remove(key) → void }
 *   - 失败时抛异常（例如配额满），调用方（systems/save.js）负责兜底。
 * 实现：
 *   - LocalStorageAdapter：浏览器 / GitHub Pages
 *   - MemoryStorageAdapter：单测、无存储能力的环境
 *   - 以后：WxStorageAdapter（wx.getStorageSync / setStorageSync / removeStorageSync）、抖音 tt.* 同理、iOS 原生桥
 */

export class LocalStorageAdapter {
  constructor(ls = globalThis.localStorage) { this.ls = ls; }
  get(key) { return this.ls.getItem(key); }
  set(key, value) { this.ls.setItem(key, value); }
  remove(key) { this.ls.removeItem(key); }
}

export class MemoryStorageAdapter {
  constructor() { this.map = new Map(); }
  get(key) { return this.map.has(key) ? this.map.get(key) : null; }
  set(key, value) { this.map.set(key, String(value)); }
  remove(key) { this.map.delete(key); }
}

/** 示例（未启用）：微信 / 抖音小游戏 */
export class WxStorageAdapter {
  constructor(api) { this.api = api; } // wx 或 tt
  get(key) { const v = this.api.getStorageSync(key); return v === '' || v === undefined ? null : v; }
  set(key, value) { this.api.setStorageSync(key, value); }
  remove(key) { this.api.removeStorageSync(key); }
}

/** 按运行环境挑一个实现（localStorage 不可用，如隐私模式抛异常，就退回内存） */
export function createDefaultStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls) { const k = '__probe__'; ls.setItem(k, '1'); ls.removeItem(k); return new LocalStorageAdapter(ls); }
  } catch { /* 不可用 */ }
  return new MemoryStorageAdapter();
}

let current = null;
/** 全局存储实例（第一次用时创建；平台入口可用 setStorage 换成别的实现） */
export function getStorage() { return (current ??= createDefaultStorage()); }
export function setStorage(adapter) { current = adapter; }
