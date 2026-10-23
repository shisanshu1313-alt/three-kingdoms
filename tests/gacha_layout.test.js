// QA-16 / SJ-06：抽卡面板按屏幕宽度自适应；QA-17：左上调试信息只在 DEBUG_HOOKS 里
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gachaLayout, PANEL_WIDE, PANEL_NARROW } from '../src/ui/gachaLayout.js';

test('gachaLayout：横屏 4 列不缩放，竖屏 380/390 宽换 2×2 并缩放到屏内', () => {
  const wide = gachaLayout(1280, 720);
  assert.equal(wide.cols, 4); assert.equal(wide.s, 1); assert.equal(wide.W, PANEL_WIDE.W);
  for (const [w, h] of [[380, 800], [390, 844], [360, 640], [414, 896]]) {
    const L = gachaLayout(w, h);
    assert.equal(L.cols, 2, `${w}×${h}`); assert.equal(L.W, PANEL_NARROW.W);
    assert.ok(L.W * L.s <= w - 16 + 1e-9 && L.H * L.s <= h - 16 + 1e-9, `${w}×${h} 面板塞进屏幕`);
    assert.ok(L.ox >= 0 && L.oy >= 0 && L.ox + L.W <= L.vw && L.oy + L.H <= L.vh, `${w}×${h} 居中在虚拟屏内`);
  }
  assert.ok(gachaLayout(390, 844).s > 0.8, '390 宽缩放不太小（≈0.83）');
  // 横屏但小（800×450）：仍 4 列，整体缩小
  const small = gachaLayout(800, 450);
  assert.equal(small.cols, 4); assert.ok(small.s < 1 && small.W * small.s <= 784);
});

test('QA-17：左上坐标 / 像素 / 地形 / 缩放 / FPS / AI 队伍数只在 DEBUG_HOOKS 里', () => {
  const src = readFileSync(new URL('../src/scenes/UIScene.js', import.meta.url), 'utf8');
  for (const key of ['坐标:', '地形:', '缩放:', 'FPS:', 'AI队伍:']) {
    const line = src.split('\n').find(l => l.includes(key) && l.includes('`'));
    assert.ok(line && /DEBUG_HOOKS \?/.test(line), `${key} 那行由 DEBUG_HOOKS 控制`);
  }
});

test('UIScene 重开（再来一局 / 读档）：layout 不碰上一局已销毁的文字，resize 监听器在 shutdown 时解绑', () => {
  const src = readFileSync(new URL('../src/scenes/UIScene.js', import.meta.url), 'utf8');
  assert.match(src, /if \(this\.log\?\.scene\) this\.log\.setWordWrapWidth/);
  assert.match(src, /this\.events\.once\('shutdown', \(\) => this\.scale\.off\('resize', onResize\)\)/);
});

test('a7d1348 复测：WorldScene / GachaScene 的 resize 监听在 shutdown 时解绑；抽卡面板 resize 时重新布局（行为见 smoke-resize）', () => {
  const ws = readFileSync(new URL('../src/scenes/WorldScene.js', import.meta.url), 'utf8');
  assert.match(ws, /this\.scale\.on\('resize', onResize\);\s*\n\s*this\.events\.once\('shutdown', \(\) => this\.scale\.off\('resize', onResize\)\)/);
  const gs = readFileSync(new URL('../src/scenes/GachaScene.js', import.meta.url), 'utf8');
  assert.match(gs, /this\.applyLayout\(\); this\.render\(\);/);
  assert.match(gs, /this\.scale\.off\('resize', onResize\)/);
});
