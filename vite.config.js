import { defineConfig } from 'vite';

// base: './' → 构建产物全部使用相对路径，可部署在任意子路径下
// （GitHub Pages：https://shisanshu1313-alt.github.io/three-kingdoms/）。
// 数据 JSON 通过 import 打包进 JS，不依赖运行时 fetch；favicon 在 public/ 下以相对路径引用。
// 正式构建（command = build）：去掉 console.log / debug / info（esbuild pure → 无副作用调用被删），保留 console.warn / error（PM 2026-10-23）。
// 开发服务器和 build:smoke（冒烟测试构建，mode = smoke）不动。
export default defineConfig(({ command, mode }) => ({
  base: './',
  esbuild: command === 'build' && mode === 'production' ? { pure: ['console.log', 'console.debug', 'console.info'] } : {},
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 }
}));
