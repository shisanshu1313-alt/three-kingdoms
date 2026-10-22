import { defineConfig } from 'vite';

// base: './' → 构建产物全部使用相对路径，可部署在任意子路径下
// （GitHub Pages：https://shisanshu1313-alt.github.io/three-kingdoms/）。
// 数据 JSON 通过 import 打包进 JS，不依赖运行时 fetch；favicon 在 public/ 下以相对路径引用。
export default defineConfig({
  base: './',
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 }
});
