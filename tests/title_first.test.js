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

// 策划 2026-10-23：点过「开始」进过一局 → meta.has_started_run = true（存储接口），之后标题页是正常版 + 「操作说明」入口
import { createMeta, parseMeta, loadMeta, saveMeta, hasStartedRun, markStartedRun, storedStartedFlag, applyRunResult } from '../src/systems/meta.js';
import { MemoryStorageAdapter as MemoryStorage } from '../src/platform/storage.js';
import { CONTROLS_HELP, controlsPanelLayout } from '../src/ui/titleMode.js';
import { run as runCfg } from '../src/data/index.js';

test('has_started_run：新 meta = false；markStartedRun → true（不改入参），经存储接口写读保持', () => {
  const m = createMeta();
  assert.equal(m.has_started_run, false);
  assert.equal(hasStartedRun(m), false);
  const m2 = markStartedRun(m);
  assert.equal(m.has_started_run, false); assert.equal(m2.has_started_run, true);
  const st = new MemoryStorage();
  saveMeta(st, 'k', m2);
  assert.equal(loadMeta(st, 'k').has_started_run, true);
  assert.equal(storedStartedFlag(st.get('k')), true);
  assert.equal(storedStartedFlag(null), false); assert.equal(storedStartedFlag('{坏'), false);
  assert.equal(storedStartedFlag(JSON.stringify(createMeta())), false);
  // 结算后的 meta 保留这个字段
  const { meta } = applyRunResult(m2, { runId: 'r', fame: 1, result: 'defeat', survivedS: 5, maxPower: 1, chapterReached: 0, namedDefeated: [] }, runCfg);
  assert.equal(meta.has_started_run, true);
});

test('has_started_run 旧档迁移：没有字段时 runs > 0 / 有解锁 → true；有任何存档（run / 坏档 / 旧版归档）→ true；否则 false', () => {
  const old = { version: 1, fameTotal: 0, runs: 0, clears: 0, bestSurvivedS: 0, bestPower: 0, namedEver: [], maxChapterEver: 0, unlocked: [], recordedRunIds: [] };
  assert.equal(parseMeta(JSON.stringify(old)).has_started_run, false);
  assert.equal(parseMeta(JSON.stringify({ ...old, runs: 1 })).has_started_run, true);
  assert.equal(parseMeta(JSON.stringify({ ...old, unlocked: ['start_spr'] })).has_started_run, true);
  assert.equal(parseMeta(JSON.stringify({ ...old, runs: 3, has_started_run: false })).has_started_run, false, '字段已存在就按字段（hasStartedRun 仍会因 runs > 0 判 true）');
  assert.equal(hasStartedRun({ ...old, runs: 3, has_started_run: false }), true);
  assert.equal(hasStartedRun(createMeta(), { runSave: true }), true);
  assert.equal(hasStartedRun(createMeta(), { legacy: true }), true);
  assert.equal(hasStartedRun(createMeta(), { runSave: false, legacy: false }), false);
  assert.equal(hasStartedRun(null), false);
});

test('titleMode：started = true → 不再是 first（没解锁、没存档也是正常版 options）', () => {
  assert.equal(titleMode({ result: null, legacy: false, unlocked: [], started: false }), 'first');
  assert.equal(titleMode({ result: null, legacy: false, unlocked: [], started: true }), 'options');
  assert.equal(titleMode({ result: { ok: true }, legacy: false, unlocked: [], started: true }), 'run');
});

test('操作说明面板：竖屏 360 / 380 / 390 宽面板和入口在屏内；说明覆盖移动 / 交战 / 抽卡 / 暂停', () => {
  for (const [w, h] of [[360, 640], [380, 800], [390, 844], [1280, 720]]) {
    const L = controlsPanelLayout(w, h);
    assert.ok(L.px >= 8 && L.px + L.pw <= w - 8 && L.wrap > 0, `${w} 面板`);
    assert.ok(L.entryX >= 0 && L.entryX + L.entryW <= w && L.entryY + L.entryH <= h, `${w} 入口`);
  }
  const all = CONTROLS_HELP.join(' ');
  for (const k of ['WASD', '点按', '交战', 'G 抽卡', 'P 暂停']) assert.ok(all.includes(k), k);
});

test('TitleScene：点「开始」进局写 has_started_run；正常版有「操作说明 [H]」入口；第一次打开版没有', () => {
  const t = readFileSync(new URL('../src/scenes/TitleScene.js', import.meta.url), 'utf8');
  assert.match(t, /newGame\(\) \{\n\s+this\.markStarted\(\);/);
  assert.match(t, /saveMeta\(getStorage\(\), META_KEY, this\.meta\)/);
  assert.match(t, /hasStartedRun\(this\.meta, \{ runSave: hasSave\(st\), legacy: this\.legacy \}\)/);
  assert.match(t, /'操作说明 \[H\]'/);
  assert.match(t, /if \(this\.mode === 'first'\) return this\.renderFirst\(add, w, h, cx\);\n[\s\S]*this\.renderHelp\(add, w, h\)/);
  assert.ok(!/renderHelp/.test(t.slice(t.indexOf('renderFirst(add, w, h, cx) {'), t.indexOf('renderHelp(add, w, h) {'))), '第一次打开版不画入口');
});
