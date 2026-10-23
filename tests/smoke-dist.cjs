// 黑盒冒烟：针对正式构建 dist（没有 window.__game 等调试钩子），只用键盘 + 存档内容判断游戏在跑。
// 用法：node tests/smoke-dist.cjs http://localhost:4174/
const { chromium } = require(process.env.PW_PATH || 'playwright-core');
const URL = process.argv[2] || 'http://localhost:4174/';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); logs.push(m.text()); });
  await page.goto(URL);
  await page.waitForTimeout(3000);
  const result = {};
  // 1) 调试钩子不存在
  result.noHooks = await page.evaluate(() => ({ game: typeof window.__game, balance: typeof window.__balance, realRng: typeof window.__realGachaRng }));
  result.noHooks.ok = Object.values(result.noHooks).every(t => t === 'undefined');
  // 2) 画布在、铺满窗口（platform/screen.js）
  result.canvas = await page.evaluate(() => { const c = document.querySelector('#game canvas'); return c && { w: c.clientWidth, h: c.clientHeight, ww: innerWidth, wh: innerHeight }; });
  result.canvas.ok = !!result.canvas && result.canvas.w === result.canvas.ww && result.canvas.h === result.canvas.wh;
  await page.setViewportSize({ width: 900, height: 600 }); await page.waitForTimeout(500);
  const rs = await page.evaluate(() => { const c = document.querySelector('#game canvas'); return { w: c.clientWidth, h: c.clientHeight }; });
  result.resize = { ...rs, ok: rs.w === 900 && rs.h === 600 };
  // 3) 正式版没有 F5 / F9（save_v05.dev）：存档只靠自动存档；这里用 pagehide（平台生命周期 → 立即存档）触发
  const readSave = () => page.evaluate(() => { const t = localStorage.getItem('sanguo-run-v1'); return t && JSON.parse(t); });
  const hideSave = async () => { await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await page.waitForTimeout(300); return readSave(); };
  const s1 = await hideSave();
  await page.keyboard.down('d'); await page.waitForTimeout(1200); await page.keyboard.up('d');
  const s2 = await hideSave();
  const p1 = s1?.player?.team?.position, p2 = s2?.player?.team?.position;
  result.saveAndMove = { v: s2?.saveVersion, runId: s2?.run?.runId, p1, p2, t1: s1?.gameTimeMs, t2: s2?.gameTimeMs,
    ok: !!(p1 && p2) && s2.saveVersion === 5 && !!s2.run?.runId && s2.run.runId === s1.run.runId && p2.x > p1.x && s2.gameTimeMs > s1.gameTimeMs };
  // 4) F2 在正式构建里没有效果（点数不变）；F9 不读档（位置不回退）
  await page.keyboard.press('F2'); await page.waitForTimeout(200);
  await page.keyboard.press('F9'); await page.waitForTimeout(300);
  const s3 = await hideSave();
  result.f2 = { before: s2?.state?.points, after: s3?.state?.points, ok: s3?.state?.points === s2?.state?.points && s3.gameTimeMs > s2.gameTimeMs };
  // 5) 刷新页面 → 标题（继续）→ Enter → 同一局、位置接上
  const p3 = s3?.player?.team?.position;
  await page.reload(); await page.waitForTimeout(2500);
  const s3b = await readSave(); // 刷新时的 pagehide 存档
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  const s4 = await hideSave();
  const p4 = s4?.player?.team?.position, pr = s3b?.player?.team?.position;
  result.reloadContinue = { p3, pReload: pr, p4, run: [s3?.run?.runId, s4?.run?.runId],
    ok: !!p4 && s4.run.runId === s3.run.runId && Math.abs(p4.x - pr.x) < 40 && Math.abs(p4.y - pr.y) < 40 };
  result.saveLogs = logs.filter(l => l.startsWith('[save]')).slice(0, 6);
  result.errors = errors;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  const ok = !errors.length && ['noHooks', 'canvas', 'resize', 'saveAndMove', 'f2', 'reloadContinue'].every(k => result[k].ok);
  console.log(ok ? 'SMOKE-DIST OK' : 'SMOKE-DIST FAIL');
  process.exit(ok ? 0 : 1);
})();
