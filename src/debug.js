/**
 * 调试 / 自动化测试钩子：window.__game、window.__balance。
 * 只在开发模式（npm run dev）和冒烟测试构建（npm run build:smoke，VITE_DEBUG_HOOKS=1）里安装；
 * 正式构建（npm run build）里 DEBUG_HOOKS 被常量折叠成 false，整段代码和这些名字都不会进 dist。
 */
export const DEBUG_HOOKS = !!(import.meta.env.DEV || import.meta.env.VITE_DEBUG_HOOKS === '1');

export function installDebugHooks(game, balance) {
  if (!DEBUG_HOOKS) return false;
  globalThis.__game = game;
  globalThis.__balance = balance;
  return true;
}
