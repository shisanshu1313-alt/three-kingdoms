// 标题页冒烟（策划 2026-10-23：has_started_run + 正常版「操作说明」入口）：
//  1) 1280×720 键盘：第一次打开 = 「开始」+ 一行操作说明 → Enter 进局 → meta.has_started_run = true（存储接口写入）
//     → 没来得及存档就关掉（删 run 存档）再打开：正常版标题（没有操作说明那行），底部「操作说明 [H]」；
//     H 打开说明面板（面板里 Enter 不开局）、Esc / H 关闭；鼠标点入口打开、点「关闭」关闭
//  2) 旧档迁移：meta 没有 has_started_run 但 runs > 0 → 正常版并写回 true；只有一个（坏的）run 存档 → 不是第一次打开，写回 true
//  3) 竖屏 380×800 / 360×640 触屏：入口、面板、每行说明、关闭按钮都在屏内；点「关闭」/ 点面板外 关闭
// 用法：node tests/smoke-title.cjs [url]（默认 http://localhost:5182/）；SHOTS=<目录> 写 title-*.png
const path = require('path');
const { chromium } = require(process.env.PW_CORE || process.env.PW_PATH || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5182/';
const SHOTS = process.env.SHOTS || path.join(__dirname, '..', 'artifacts');
const RUN_KEY = 'sanguo-run-v1', META_KEY = 'sanguo-meta-v1';
let n = 0;
(async () => {
  require('fs').mkdirSync(SHOTS, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const errs = [];
  let p;
  const fail = async msg => { console.error('not ok', ++n, '-', msg); console.error(errs.join('\n')); await p.screenshot({ path: path.join(SHOTS, 'title-fail.png') }); await b.close(); process.exit(1); };
  const ok = async (c, msg) => (c ? console.log('ok', ++n, '-', msg) : fail(msg));
  const W = (fn, a) => p.evaluate(fn, a);
  let ctx;
  const newPage = async (opts) => { if (opts) ctx = await b.newContext(opts); p = await ctx.newPage(); p.on('pageerror', e => errs.push(String(e) + (e.stack ? '\n' + e.stack : ''))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); };
  const toTitle = async () => { await p.reload(); await p.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 20000 }); await p.waitForTimeout(400); };
  const meta = () => W(k => JSON.parse(localStorage.getItem(k) || 'null'), META_KEY);
  // 标题页状态（屏幕坐标：标题页镜头 = 画布，不缩放；k = CSS 像素 / 游戏像素）
  const T = () => W(() => {
    const t = __game.scene.getScene('Title'), r = __game.canvas.getBoundingClientRect(), k = r.width / __game.scale.width;
    const box = (o, w, h) => o && { l: o.x, t: o.y, r: o.x + w, b: o.y + h };
    const bb = c => c && box(c, c.bg.width, c.bg.height);
    const tap = q => q && { x: r.left + (q.l + q.r) / 2 * k, y: r.top + (q.t + q.b) / 2 * k };
    const H = t.helpPanel, entry = bb(t.btnHelp), close = H && bb(H.close);
    return { mode: t.mode, help: t.helpOpen, sw: __game.scale.width, sh: __game.scale.height, world: __game.scene.isActive('World'),
      ctl: t.controlsText?.text ?? null, ctlInRoot: t.root.list.some(o => typeof o.text === 'string' && o.text.startsWith('操作：')),
      entry, entryLabel: t.btnHelp?.label.text, panel: H && box(H.panel, H.panel.width, H.panel.height), close,
      lines: H ? H.lines.map(o => ({ l: o.x, r: o.x + o.width, t: o.y, b: o.y + o.height, s: o.text })) : [],
      tapEntry: tap(entry), tapClose: tap(close), tapOutside: { x: r.left + 4 * k, y: r.top + 4 * k } };
  });
  const inside = (q, S) => q && q.l >= -0.5 && q.t >= -0.5 && q.r <= S.sw + 0.5 && q.b <= S.sh + 0.5;

  // 1) 1280×720 键盘 / 鼠标
  await newPage({ viewport: { width: 1280, height: 720 } });
  await p.goto(URL); await W(() => localStorage.clear()); await toTitle();
  let S = await T();
  await ok(S.mode === 'first' && /^操作：/.test(S.ctl ?? '') && !S.entry && !(await meta())?.has_started_run, `第一次打开：「开始」+ 操作说明，没有「操作说明」入口（${S.mode}）`);
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.__game.scene.getScene('World')?.player, null, { timeout: 20000 });
  await ok((await meta())?.has_started_run === true, '点「开始」进局 → meta.has_started_run = true（存储里）');
  // 没来得及存档就关掉：关页面（离开时可能自动存档），新开页面在游戏脚本之前删掉 run 存档 → 只剩 meta
  await p.close(); await newPage(); // 同一个浏览器上下文（同一份 localStorage）
  await p.addInitScript(k => { if (!sessionStorage.getItem('rm')) { sessionStorage.setItem('rm', '1'); localStorage.removeItem(k); } }, RUN_KEY);
  await p.goto(URL); await p.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 20000 }); await p.waitForTimeout(400); S = await T();
  await ok(S.mode === 'options' && S.ctl === null && !S.ctlInRoot && S.entryLabel === '操作说明 [H]' && inside(S.entry, S), `进过一局（没存档、没解锁）再打开：正常版标题，没有操作说明那行，有入口「${S.entryLabel}」 ${JSON.stringify({ mode: S.mode, ctl: S.ctl, inRoot: S.ctlInRoot, entry: S.entry })}`);
  await p.keyboard.press('h'); await p.waitForTimeout(200); S = await T();
  await ok(S.help && inside(S.panel, S) && S.lines.length >= 4 && S.lines.every(l => inside(l, S)) && /WASD/.test(S.lines[0].s), `H 打开说明面板（${S.lines.length} 行）`);
  await p.screenshot({ path: path.join(SHOTS, 'title-help-1280.png') });
  await p.keyboard.press('Enter'); await p.waitForTimeout(300); S = await T();
  await ok(!S.help && !S.world && S.mode === 'options', '面板开着时 Enter 只关面板，不开局');
  await p.keyboard.press('h'); await p.waitForTimeout(200); await p.keyboard.press('Escape'); await p.waitForTimeout(200); S = await T();
  await ok(!S.help, 'H 打开 → Esc 关闭');
  await p.mouse.click(S.tapEntry.x, S.tapEntry.y); await p.waitForTimeout(200); S = await T();
  await ok(S.help, '鼠标点「操作说明」入口打开');
  await p.mouse.click(S.tapClose.x, S.tapClose.y); await p.waitForTimeout(200); S = await T();
  await ok(!S.help && !S.world, '鼠标点「关闭」关闭');

  // 2) 旧档迁移
  await W(k => { localStorage.clear(); localStorage.setItem(k, JSON.stringify({ version: 1, fameTotal: 40, runs: 2, clears: 0, bestSurvivedS: 100, bestPower: 50, namedEver: [], maxChapterEver: 0, unlocked: [], recordedRunIds: ['a', 'b'] })); }, META_KEY);
  await toTitle(); S = await T();
  await ok(S.mode === 'options' && !S.ctlInRoot && S.entry && (await meta()).has_started_run === true && (await meta()).runs === 2, `旧 meta（没有 has_started_run，runs = 2）→ 正常版标题，写回 has_started_run = true，其他字段不变 ${JSON.stringify({ mode: S.mode, m: await meta() })}`);
  await W(k => { localStorage.clear(); localStorage.setItem(k, '{坏档'); }, RUN_KEY);
  await toTitle(); S = await T();
  await ok(S.mode === 'error' && !S.ctlInRoot && (await meta())?.has_started_run === true, `只有一个（坏的）run 存档、没有 meta → 不是第一次打开（${S.mode}），写回 has_started_run = true`);
  await p.close();

  // 3) 竖屏触屏
  for (const [vw, vh] of [[380, 800], [360, 640]]) {
    await newPage({ viewport: { width: vw, height: vh }, hasTouch: true, isMobile: true });
    await p.goto(URL); await W(k => { localStorage.clear(); localStorage.setItem(k, JSON.stringify({ version: 1, runs: 0, has_started_run: true })); }, META_KEY);
    await toTitle(); S = await T();
    await ok(S.mode === 'options' && inside(S.entry, S), `${vw}×${vh}：正常版标题，入口在屏内 ${JSON.stringify(S.entry)}`);
    await p.touchscreen.tap(S.tapEntry.x, S.tapEntry.y); await p.waitForTimeout(300); S = await T();
    await ok(S.help && inside(S.panel, S) && inside(S.close, S) && S.lines.every((l, i) => l.l >= S.panel.l && l.r <= S.panel.r + 0.5 && l.t >= S.panel.t && l.b <= S.close.t && (i === 0 || S.lines[i - 1].b <= l.t + 0.5)), `${vw}×${vh}：点入口打开面板；面板 / 每行说明（不重叠）/ 关闭按钮都在屏内 ${JSON.stringify({ panel: S.panel, close: S.close })}`);
    await p.screenshot({ path: path.join(SHOTS, `title-help-${vw}.png`) });
    await p.touchscreen.tap(S.tapClose.x, S.tapClose.y); await p.waitForTimeout(300); S = await T();
    await ok(!S.help && !S.world, `${vw}×${vh}：点「关闭」关闭`);
    await p.touchscreen.tap(S.tapEntry.x, S.tapEntry.y); await p.waitForTimeout(300);
    await p.touchscreen.tap(S.tapOutside.x, S.tapOutside.y); await p.waitForTimeout(300); S = await T();
    await ok(!S.help && !S.world && S.mode === 'options', `${vw}×${vh}：点面板外也关闭（不开局）`);
    await p.close();
  }
  await b.close();
  if (errs.length) { console.error('not ok', ++n, '- 页面错误', errs.join('\n')); process.exit(1); }
  console.log('ok', ++n, '- 无页面错误');
  console.log(`SMOKE-TITLE OK (${n} checks)`);
})().catch(e => { console.error(e); process.exit(1); });
