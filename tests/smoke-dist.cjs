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
  // 3) F5 存档 → 键盘移动 → F5 → 存档里玩家位置变了，游戏时间在走
  const readSave = () => page.evaluate(() => { const t = localStorage.getItem('sanguo-save'); return t && JSON.parse(t); });
  await page.keyboard.press('F5'); await page.waitForTimeout(300);
  const s1 = await readSave();
  await page.keyboard.down('d'); await page.waitForTimeout(1200); await page.keyboard.up('d');
  await page.keyboard.press('F5'); await page.waitForTimeout(300);
  const s2 = await readSave();
  const p1 = s1?.player?.team?.position, p2 = s2?.player?.team?.position;
  result.saveAndMove = { v: s2?.saveVersion, p1, p2, t1: s1?.gameTimeMs, t2: s2?.gameTimeMs,
    ok: !!(p1 && p2) && s2.saveVersion === 3 && p2.x > p1.x && s2.gameTimeMs > s1.gameTimeMs };
  // 4) F2 在正式构建里没有效果（点数不变）
  await page.keyboard.press('F2'); await page.waitForTimeout(200); await page.keyboard.press('F5'); await page.waitForTimeout(300);
  const s3 = await readSave();
  result.f2 = { before: s2?.state?.points, after: s3?.state?.points, ok: s3?.state?.points === s2?.state?.points };
  // 5) 刷新页面 → 标题菜单 → Enter 继续 → 存档位置接上
  await page.reload(); await page.waitForTimeout(2500);
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  await page.keyboard.press('F5'); await page.waitForTimeout(300);
  const s4 = await readSave();
  const p4 = s4?.player?.team?.position;
  result.reloadContinue = { p3: s3?.player?.team?.position, p4, ok: !!p4 && Math.abs(p4.x - s3.player.team.position.x) < 1 && Math.abs(p4.y - s3.player.team.position.y) < 1 };
  result.saveLogs = logs.filter(l => l.startsWith('[save]')).slice(0, 6);
  result.errors = errors;
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  const ok = !errors.length && ['noHooks', 'canvas', 'resize', 'saveAndMove', 'f2', 'reloadContinue'].every(k => result[k].ok);
  console.log(ok ? 'SMOKE-DIST OK' : 'SMOKE-DIST FAIL');
  process.exit(ok ? 0 : 1);
})();
