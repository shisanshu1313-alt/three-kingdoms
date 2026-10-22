// 解析钩子：任何模块 import 'phaser'（或 phaser/...）都直接报错
export async function resolve(specifier, context, next) {
  if (specifier === 'phaser' || specifier.startsWith('phaser/')) {
    throw new Error(`禁止在纯逻辑模块里 import phaser（来自 ${context.parentURL}）`);
  }
  return next(specifier, context);
}
