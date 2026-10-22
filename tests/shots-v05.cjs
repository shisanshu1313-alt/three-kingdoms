// v0.5 原型展示截图（不是断言测试）：三方混战（第三方加入）、骑兵冲击、AI 追击/放弃。
// 用法：node tests/shots-v05.cjs [url]（默认 http://localhost:5180/）→ artifacts/v05-*.png
const path = require('path');
const { chromium } = require(process.env.PW_CORE || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5180/';
const OUT = path.join(__dirname, '..', 'artifacts');
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  const logs = []; p.on('console', m => logs.push(m.text())); p.on('pageerror', e => logs.push('PAGEERROR ' + e));
  await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(3000);
  if (await p.evaluate(() => window.__game?.scene.isActive('Title'))) { await p.keyboard.press('Enter'); await p.waitForTimeout(1500); }
  // 场景：玩家（步）在空地；黄巾（步）正面贴上；过 1 s 另一支黄巾从下方贴上来加入
  await p.evaluate(() => {
    const w = __game.scene.getScene('World'), pl = w.player;
    w.cameras.main.setZoom(1.6);
    const ox = pl.x + 260, oy = pl.y - 40; // 城外空地
    w.field.teleport(pl, ox, oy);
    const bs = w.aiParties.filter(a => a.faction === 'bandit');
    const inf = bs.find(a => a.team.unit === 'inf') ?? bs[0], cav = bs.find(a => a !== inf);
    const rr = (q) => w.views.get(q).radius;
    w.field.teleport(inf, ox + rr(pl) + rr(inf) - 1, oy);
  });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: path.join(OUT, 'v05-1v1.png') });
  // 第三方：另一支黄巾从下方贴上来 → 加入（伤害按战力份额分摊）
  await p.evaluate(() => {
    const w = __game.scene.getScene('World'), pl = w.player;
    const bs = w.aiParties.filter(a => a.faction === 'bandit' && !a.inBattle);
    const c = bs.sort((a, b) => Math.hypot(a.x - pl.x, a.y - pl.y) - Math.hypot(b.x - pl.x, b.y - pl.y))[0];
    if (c) w.field.teleport(c, pl.x - 8, pl.y + w.views.get(pl).radius + w.views.get(c).radius - 2);
  });
  await p.waitForTimeout(1400);
  await p.screenshot({ path: path.join(OUT, 'v05-third-party.png') });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(OUT, 'v05-melee.png') });
  // 玩家往左开走：AI 追击 → 放弃 → 脱离
  await p.mouse.click(550, 650); await p.keyboard.down('a');
  await p.waitForTimeout(3500);
  await p.screenshot({ path: path.join(OUT, 'v05-pursuit.png') });
  await p.waitForTimeout(5000);
  await p.keyboard.up('a');
  await p.screenshot({ path: path.join(OUT, 'v05-end.png') });
  console.log(logs.filter(l => /^\[(battle|escape|fx)|PAGEERROR/.test(l)).join('\n'));
  await b.close();
})();
