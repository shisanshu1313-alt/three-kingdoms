// QA-10 / 策划：第一次打开（没存档、没解锁）也先出标题页 —— 「开始」按钮 + 一行操作说明；有存档保持原样。npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { titleMode, firstRunLayout, FIRST_RUN_CONTROLS } from '../src/ui/titleMode.js';

test('titleMode：没存档没解锁 → first；有存档 → run；坏档 → error；有解锁 / 旧档 → options', () => {
  assert.equal(titleMode({ result: null, legacy: false, unlocked: [] }), 'first');
  assert.equal(titleMode({ result: { ok: true }, legacy: false, unlocked: [] }), 'run');
  assert.equal(titleMode({ result: { ok: false, code: 'corrupt' }, legacy: false, unlocked: [] }), 'error');
  assert.equal(titleMode({ result: null, legacy: false, unlocked: ['start_spr'] }), 'options');
  assert.equal(titleMode({ result: null, legacy: true, unlocked: [] }), 'options');
});

test('firstRunLayout：竖屏 360 / 380 / 390 宽按钮和说明都在屏内；横屏按钮 240', () => {
  for (const [w, h] of [[360, 640], [380, 800], [390, 844]]) {
    const L = firstRunLayout(w, h);
    assert.ok(L.btnW <= w - 32 && L.wrap <= w - 32 && L.btnW >= 200, `${w}`);
  }
  assert.equal(firstRunLayout(1280, 720).btnW, 240);
  assert.match(FIRST_RUN_CONTROLS, /^操作：/); assert.ok(!FIRST_RUN_CONTROLS.includes('\n'), '一行说明');
});

test('BootScene 总是先进标题页（不再直接开局）', () => {
  const src = readFileSync(new URL('../src/scenes/BootScene.js', import.meta.url), 'utf8');
  assert.ok(!/scene\.start\('World'/.test(src));
  assert.match(src, /this\.scene\.start\('Title', \{ legacy \}\)/);
  const t = readFileSync(new URL('../src/scenes/TitleScene.js', import.meta.url), 'utf8');
  assert.match(t, /if \(this\.mode === 'first'\) return this\.renderFirst/);
  assert.match(t, /'开始 \[Enter\]', \(\) => this\.newGame\(\)/);
});
