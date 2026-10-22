import test from 'node:test';
import assert from 'node:assert/strict';
import { WebScreenAdapter, WxScreenAdapter, FixedScreenAdapter, scaleConfig, getScreen, setScreen, createDefaultScreen } from '../src/platform/screen.js';

test('网页：窗口尺寸，RESIZE（与以前 window.innerWidth/innerHeight + Scale.RESIZE 相同）', () => {
  const s = new WebScreenAdapter({ innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2 });
  assert.deepEqual(s.size(), { width: 1280, height: 720, pixelRatio: 2 });
  assert.deepEqual(scaleConfig(s), { mode: 'RESIZE', width: 1280, height: 720 });
});

test('小游戏：getSystemInfoSync，固定尺寸', () => {
  const s = new WxScreenAdapter({ getSystemInfoSync: () => ({ windowWidth: 414, windowHeight: 896, pixelRatio: 3 }) });
  assert.deepEqual(scaleConfig(s), { mode: 'NONE', width: 414, height: 896 });
});

test('Node 里没有 window：默认固定尺寸；setScreen 可替换', () => {
  assert.ok(createDefaultScreen() instanceof FixedScreenAdapter);
  const f = new FixedScreenAdapter(800, 600);
  setScreen(f);
  assert.equal(getScreen(), f);
  assert.deepEqual(scaleConfig(), { mode: 'NONE', width: 800, height: 600 });
  setScreen(null);
});
