// resize / 重开冒烟（QA a7d1348 复测 §5.1–5.3 + 标题居中）：
//  1) WorldScene / UIScene 的 scale 'resize' 监听数在 重开（scene.restart = F9 读档同一路径）×3、结算→再来一局 后保持不变；之后 resize 不报错、小地图贴右上
//  2) 抽卡面板开着时转屏：1280×720（4 列）→ 390×844（2×2，面板 / 卡 / 按钮在屏内）→ 1280×720（4 列）
//  3) 有存档 → 标题 → 放弃本局（N → Y）→ 新一局面板：resize 前后标题、按钮都水平居中，镜头 = 画布 = 窗口
// 用法：node tests/smoke-resize.cjs [url]（默认 http://localhost:5182/）；SHOTS=<目录> 写 resize-*.png
const path = require('path');
const { chromium } = require(process.env.PW_CORE || process.env.PW_PATH || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5182/';
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'artifacts');
let n = 0;
(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e) + (e.stack ? '\n' + e.stack : '')));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const fail = async msg => { console.error('not ok', ++n, '-', msg); console.error(errs.join('\n')); await p.screenshot({ path: path.join(SHOTS, 'resize-fail.png') }); await b.close(); process.exit(1); };
  const ok = async (c, msg) => (c ? console.log('ok', ++n, '-', msg) : fail(msg));
  const W = (fn, a) => p.evaluate(fn, a);
  const size = async (w, h) => { await p.setViewportSize({ width: w, height: h }); await p.waitForTimeout(600); };
  const worldUp = () => p.waitForFunction(() => __game.scene.isActive('World') && __game.scene.isActive('UI') && __game.scene.getScene('UI').gachaBtn, null, { timeout: 30000 });
  const cnt = () => W(() => __game.scale.listenerCount('resize'));

  await p.goto(URL); await W(() => localStorage.clear()); await p.reload();
  await p.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 20000 });
  await p.keyboard.press('Enter'); await worldUp(); await p.waitForTimeout(500);
  const c0 = await cnt();
  for (let i = 0; i < 3; i++) { await W(() => __game.scene.getScene('World').scene.restart({ newRun: {} })); await p.waitForTimeout(300); await worldUp(); await p.waitForTimeout(500); }
  const c3 = await cnt();
  await ok(c3 === c0, `重开 3 次（scene.restart，同 F9 读档）后 resize 监听数不变（${c0} → ${c3}）`);
  // 结算 → 再来一局（Enter）
  await W(() => { const w = __game.scene.getScene('World'); w.run.heroHp = 0; w.endRun(); });
  await p.waitForFunction(() => __game.scene.isActive('RunEnd'), null, { timeout: 10000 });
  await p.keyboard.press('Enter'); await worldUp(); await p.waitForTimeout(500);
  const c4 = await cnt();
  await ok(c4 === c0, `结算 → 再来一局 后 resize 监听数不变（${c0} → ${c4}）`);
  await size(390, 844); await size(1280, 720);
  const mm = await W(() => { const w = __game.scene.getScene('World'); return { x: w.minimap.x, w: w.minimap.width, sw: __game.scale.width }; });
  await ok(Math.abs(mm.x + mm.w + 10 - mm.sw) < 1, `重开后 resize：小地图仍贴右上（${JSON.stringify(mm)}）`);

  // 2) 抽卡面板开着时转屏
  await W(() => { const w = __game.scene.getScene('World'); w.run.raidDone = true; w.player.invincibleUntil = w.clock.now + 600000; w.state.points = 500; });
  await p.keyboard.press('g'); await p.waitForTimeout(500);
  await ok(await W(() => __game.scene.isActive('Gacha')), 'G 打开抽卡面板');
  await p.keyboard.press('Space'); await p.waitForTimeout(400);
  const geo = () => W(() => {
    const g = __game.scene.getScene('Gacha'), cam = g.cameras.main, sc = (x, y) => [(x - cam.worldView.x) * cam.zoom, (y - cam.worldView.y) * cam.zoom];
    const box = (x, y, w, h) => { const [x0, y0] = sc(x, y), [x1, y1] = sc(x + w, y + h); return { x0, y0, x1, y1 }; };
    const cards = (g.cardRects ?? []).map(r => box(r.x, r.y, r.w, r.h));
    return { cols: g.layout.cols, zoom: cam.zoom, camW: cam.width, sw: __game.scale.width, sh: __game.scale.height, state: g.uiState, panel: box(g.ox, g.oy, g.W, g.H), cards };
  });
  const inside = (r, G) => r && r.x0 >= -0.5 && r.y0 >= -0.5 && r.x1 <= G.sw + 0.5 && r.y1 <= G.sh + 0.5;
  let G = await geo();
  await ok(G.cols === 4 && G.state === 'OFFER' && inside(G.panel, G), `1280×720：抽卡面板 4 列（${G.state}）`);
  await size(390, 844); G = await geo();
  await ok(G.cols === 2 && G.camW === 390 && G.state === 'OFFER' && inside(G.panel, G) && G.cards.length === 4 && G.cards.every(r => inside(r, G)), `面板开着转到 390×844：换成 2×2、面板 / 4 张卡在屏内（缩放 ${G.zoom.toFixed(2)}，${JSON.stringify(G.panel)}）`);
  await p.screenshot({ path: path.join(SHOTS, 'resize-gacha-390.png') });
  await size(1280, 720); G = await geo();
  await ok(G.cols === 4 && G.camW === 1280 && inside(G.panel, G) && Math.abs((G.panel.x0 + G.panel.x1) / 2 - 640) < 2, `转回 1280×720：4 列、面板居中（${JSON.stringify(G.panel)}）`);
  await p.keyboard.press('1'); await p.waitForTimeout(300);
  for (const k of ['1', 'Escape', 'Escape']) { if (!(await W(() => __game.scene.isActive('Gacha')))) break; await p.keyboard.press(k); await p.waitForTimeout(300); }
  if (await W(() => __game.scene.isActive('Roster'))) { await p.keyboard.press('Escape'); await p.waitForTimeout(300); }

  // 3) 有存档 → 刷新 → 标题（继续 / 放弃）→ 放弃（N → Y）→ 新一局面板：居中、resize 后仍居中
  await W(() => __game.scene.getScene('World').trySaveNow('manual'));
  await p.reload(); await p.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 20000 }); await p.waitForTimeout(400);
  const center = () => W(() => { const t = __game.scene.getScene('Title'), cam = t.cameras.main, b = t.btnNew, c = __game.canvas.getBoundingClientRect();
    const title = t.root.list.find(o => o.text === '三国 · 群雄逐鹿');
    return { mode: t.mode, sw: __game.scale.width, sh: __game.scale.height, iw: innerWidth, ih: innerHeight, cw: c.width, camW: cam.width, camH: cam.height, sx: cam.scrollX, sy: cam.scrollY,
      titleX: title?.x, btnCx: b ? b.x + b.bg.width / 2 : null }; });
  const centered = C => C.sw === C.iw && C.sh === C.ih && C.cw === C.iw && C.camW === C.sw && C.camH === C.sh && C.sx === 0 && C.sy === 0 && Math.abs(C.titleX - C.sw / 2) < 1 && Math.abs(C.btnCx - C.sw / 2) < 1;
  let C = await center();
  await ok(C.mode === 'run' && centered(C), `刷新后标题页「继续 / 放弃本局」且居中（mode ${C.mode}）`);
  await p.keyboard.press('n'); await p.waitForTimeout(300); await p.keyboard.press('y'); await p.waitForTimeout(500);
  C = await center();
  await ok((C.mode === 'first' || C.mode === 'options') && centered(C), `放弃本局后回到新一局面板（${C.mode}）：标题 / 按钮水平居中，镜头 = 画布 = 窗口（${JSON.stringify(C)}）`);
  await p.screenshot({ path: path.join(SHOTS, 'resize-title-after-abandon-1280.png') });
  for (const [w, h] of [[390, 844], [1920, 1080], [1024, 640]]) {
    await size(w, h); C = await center();
    await ok(centered(C), `放弃后的标题页 resize 到 ${w}×${h}：仍居中（${JSON.stringify(C)}）`);
  }
  await p.screenshot({ path: path.join(SHOTS, 'resize-title-after-abandon-1024.png') });
  await b.close();
  if (errs.length) { console.error('not ok', ++n, '- 页面错误', errs.join('\n')); process.exit(1); }
  console.log('ok', ++n, '- 无页面错误');
  console.log(`SMOKE-RESIZE OK (${n} checks)`);
})().catch(e => { console.error(e); process.exit(1); });
