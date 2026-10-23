// 竖屏冒烟（QA-16 / SJ-06 / QA-17）：380×800 和 390×844 下点「抽卡」按钮 → 面板、4 张卡、关闭 / 换一批 / 抽卡按钮都完整在屏内且能点；
// 左上调试信息（坐标 / 像素 / FPS）只在开发版（开发服务器上应存在，正式包 smoke-dist 检查不存在）。
// 用法：node tests/smoke-portrait.cjs [url]（默认 http://localhost:5182/）；SHOTS=<目录> 写 portrait-gacha-<w>.png
const path = require('path');
const { chromium } = require(process.env.PW_CORE || process.env.PW_PATH || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5182/';
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'artifacts');
let n = 0;
(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const errs = [];
  const fail = async (p, msg) => { console.error('not ok', ++n, '-', msg); await p.screenshot({ path: path.join(SHOTS, 'portrait-fail.png') }); await b.close(); process.exit(1); };
  for (const [vw, vh] of [[380, 800], [390, 844]]) {
    const p = await b.newPage({ viewport: { width: vw, height: vh }, hasTouch: true, isMobile: true });
    p.on('pageerror', e => errs.push(String(e)));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    const ok = async (c, msg) => (c ? console.log('ok', ++n, '-', msg) : fail(p, msg));
    const W = (fn, a) => p.evaluate(fn, a);
    await p.goto(URL); await W(() => localStorage.clear()); await p.reload();
    await p.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 20000 });
    // QA-10：第一次打开 → 标题页「开始」+ 一行操作说明，竖屏放得下；触屏点「开始」进对局
    await p.waitForTimeout(300);
    const tt = await W(() => { const t = __game.scene.getScene('Title'), b = t.btnNew, c = t.controlsText, r = __game.canvas.getBoundingClientRect(), k = r.width / __game.scale.width;
      return { mode: t.mode, label: b?.label.text, cont: !!t.btnContinue, sw: __game.scale.width, sh: __game.scale.height,
        btn: b && { l: b.x, r: b.x + b.bg.width, t: b.y, b: b.y + b.bg.height }, txt: c && { l: c.x - c.width / 2, r: c.x + c.width / 2, b: c.y + c.height, s: c.text },
        tap: b && { x: r.left + (b.x + b.bg.width / 2) * k, y: r.top + (b.y + b.bg.height / 2) * k } }; });
    await ok(tt.mode === 'first' && /^开始/.test(tt.label) && !tt.cont && tt.btn.l >= 0 && tt.btn.r <= tt.sw && tt.btn.b <= tt.sh
      && tt.txt.l >= 0 && tt.txt.r <= tt.sw && tt.txt.b <= tt.sh && /^操作：/.test(tt.txt.s), `${vw}×${vh}：第一次打开出标题页（开始按钮 + 操作说明都在屏内）${JSON.stringify({ ...tt, tap: undefined })}`);
    await p.screenshot({ path: path.join(SHOTS, `portrait-title-${vw}.png`) });
    await p.touchscreen.tap(tt.tap.x, tt.tap.y);
    await p.waitForFunction(() => window.__game.scene.getScene('World')?.player && window.__game.scene.getScene('UI')?.gachaBtn, null, { timeout: 20000 });
    await W(() => { const w = __game.scene.getScene('World'); w.run.raidDone = true; w.player.invincibleUntil = w.clock.now + 600000; w.state.points = 500; });
    await p.waitForTimeout(300);
    // 点右上「抽卡」按钮（触屏 tap）
    const gb = await W(() => { const u = __game.scene.getScene('UI'), c = u.gachaBtn, r = __game.canvas.getBoundingClientRect(), k = r.width / __game.scale.width;
      return { x: r.left + (c.x + c.bg.width / 2) * k, y: r.top + (c.y + c.bg.height / 2) * k }; });
    await p.touchscreen.tap(gb.x, gb.y); await p.waitForTimeout(400);
    await ok(await W(() => __game.scene.isActive('Gacha')), `${vw}×${vh}：点「抽卡」按钮打开抽卡面板`);
    // 屏幕坐标：GachaScene 镜头缩放
    const geo = () => W(() => {
      const g = __game.scene.getScene('Gacha'), cam = g.cameras.main, sw = __game.scale.width, sh = __game.scale.height;
      const tr = (x, y) => ({ x: (x - cam.worldView.x) * cam.zoom, y: (y - cam.worldView.y) * cam.zoom });
      const box = (x, y, w, h) => { const a = tr(x, y), c = tr(x + w, y + h); return { x0: a.x, y0: a.y, x1: c.x, y1: c.y }; };
      const btn = c => c && box(c.x, c.y, c.bg.width, c.bg.height);
      return { sw, sh, zoom: cam.zoom, cols: g.layout.cols, panel: box(g.ox, g.oy, g.W, g.H), cards: (g.cardRects ?? []).map(r => box(r.x, r.y, r.w, r.h)),
        close: btn(g.closeBtn?.active ? g.closeBtn : null), open: btn(g.openBtn), refresh: btn(g.refreshBtn?.active ? g.refreshBtn : null), state: g.uiState };
    });
    const inside = (r, G) => r && r.x0 >= -0.5 && r.y0 >= -0.5 && r.x1 <= G.sw + 0.5 && r.y1 <= G.sh + 0.5;
    let G = await geo();
    await ok(G.cols === 2 && inside(G.panel, G) && inside(G.open, G) && inside(G.close, G) && G.zoom >= 0.75, `${vw}×${vh}：窄屏布局（2 列，缩放 ${G.zoom.toFixed(2)}），面板 / 抽卡按钮 / 关闭按钮都在屏内 ${JSON.stringify(G.panel)}`);
    // 点「抽卡」按钮出 4 张
    const tapBox = async r => { const k = await W(() => { const c = __game.canvas.getBoundingClientRect(); return { l: c.left, t: c.top, k: c.width / __game.scale.width }; }); await p.touchscreen.tap(k.l + (r.x0 + r.x1) / 2 * k.k, k.t + (r.y0 + r.y1) / 2 * k.k); };
    await tapBox(G.open); await p.waitForTimeout(400);
    G = await geo();
    await ok(G.state === 'OFFER' && G.cards.length === 4 && G.cards.every(r => inside(r, G)) && inside(G.refresh, G), `${vw}×${vh}：点抽卡 → 4 张卡全部在屏内、「换一批」在屏内（${G.cards.map(r => `${r.x0 | 0},${r.y0 | 0}-${r.x1 | 0},${r.y1 | 0}`).join(' ')}）`);
    await p.screenshot({ path: path.join(SHOTS, `portrait-gacha-${vw}.png`) });
    // 点第 3 张卡（触屏）→ 结果；之后「关闭」按钮能点
    await tapBox(G.cards[2]); await p.waitForTimeout(400);
    G = await geo();
    if (G.state === 'CHOOSE_UNIT' || G.state === 'ITEM_FULL') { await p.keyboard.press('1'); await p.waitForTimeout(300); G = await geo(); }
    if (G.state === 'ROSTER_FULL') { await p.keyboard.press('Escape'); await p.waitForTimeout(300); G = await geo(); }
    await ok(G.state === 'RESULT' && inside(G.close, G), `${vw}×${vh}：点卡片选中 → 结果，关闭按钮在屏内（${G.state}）`);
    await p.screenshot({ path: path.join(SHOTS, `portrait-gacha-result-${vw}.png`) });
    await tapBox(G.close); await p.waitForTimeout(400);
    await ok(!(await W(() => __game.scene.isActive('Gacha'))), `${vw}×${vh}：点「关闭」按钮关掉面板`);
    // QA-17：开发版左上信息在（坐标 / FPS），且不盖住小地图（窄屏缩小 / 截断到小地图左边）
    const info = await W(() => { const u = __game.scene.getScene('UI'), t = u.info; return t ? { text: t.text, right: t.x + t.width * t.scaleX, mm: __game.scene.getScene('World').minimap?.x } : null; });
    await ok(info && /FPS/.test(info.text) && (info.mm == null || info.right <= info.mm + 0.5), `${vw}×${vh}：开发版左上调试信息不盖住小地图（右边 ${info?.right?.toFixed(0)} ≤ 小地图 ${info?.mm}）`);
    await p.close();
  }
  await b.close();
  if (errs.length) { console.error('not ok', ++n, '- 页面错误', errs.join('\n')); process.exit(1); }
  console.log('ok', ++n, '- 无页面错误');
  console.log(`SMOKE-PORTRAIT OK (${n} checks)`);
})().catch(e => { console.error(e); process.exit(1); });
