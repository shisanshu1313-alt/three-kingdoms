// v0.5 实时接触战斗 浏览器冒烟：接触战斗发生 → 战斗中刷新读档继续 → 玩家把队伍开走 → 脱离（escape + 保护）。
// 用法：node tests/smoke-v05.cjs [url]（默认 http://localhost:5180/）；截图写到 artifacts/
const path = require('path');
const { chromium } = require(process.env.PW_CORE || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5180/';
const OUT = path.join(__dirname, '..', 'artifacts');
const sleep = (p, ms) => p.waitForTimeout(ms);
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1100, height: 700 } });
  const errs = [], logs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { logs.push(m.text()); if (m.type() === 'error') errs.push(m.text()); });
  const fail = async (msg) => { console.error('FAIL:', msg); console.error(logs.slice(-30).join('\n')); await p.screenshot({ path: path.join(OUT, 'v05-fail.png') }); await b.close(); process.exit(1); };
  await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.reload(); await sleep(p, 3000);
  if (await p.evaluate(() => window.__game?.scene.isActive('Title'))) { await p.keyboard.press('Enter'); await sleep(p, 1500); }
  await p.mouse.click(550, 600); await sleep(p, 300); // 聚焦（点地图会设路径，下面键盘会取消）
  const st = () => p.evaluate(() => {
    const w = __game.scene.getScene('World'), pl = w.player, f = w.field, bd = f.body(pl.id);
    const pairs = Object.values(f.state.pairs).filter(q => q.a === pl.id || q.b === pl.id);
    return { x: bd.x, y: bd.y, n: bd.N0 * (1 - bd.raw), inBattle: !!pl.inBattle, contact: pairs.some(q => q.wasContact), pairs: pairs.length,
      prot: pl.invincibleUntil > w.clock.now, t: f.state.t };
  });
  // 把一支黄巾步兵（同速：追 3 s 放弃）放到玩家右侧贴身处，玩家朝它开 → 接触
  const foe = await p.evaluate(() => {
    const w = __game.scene.getScene('World'), pl = w.player;
    const dist = (a) => Math.hypot(a.x - pl.x, a.y - pl.y);
    const bs = w.aiParties.filter(a => a.faction === 'bandit');
    const e = (bs.filter(a => a.team.unit === 'inf').sort((a, b) => dist(a) - dist(b))[0]) ?? bs.sort((a, b) => dist(a) - dist(b))[0]; // 同速步兵：追 3 s 后放弃
    // 敌方战力调到玩家的 ~1.3 倍：不会平局（< 1.05 才平），玩家是弱势方、几秒内不会溃
    for (let k = 0; k < 5; k++) { const r = e.power / pl.power; e.team.soldiers = Math.max(5, Math.round(e.team.soldiers * 1.3 / r)); e.refresh(); w.field.refresh(e); }
    const ra = w.views.get(pl).radius, rb = w.views.get(e).radius;
    w.field.teleport(e, pl.x + ra + rb + 4, pl.y); return e.team.name; // 贴身放置，玩家往右一开就接触
  });
  await p.keyboard.down('d');
  let s, t0 = Date.now();
  while (Date.now() - t0 < 5000) { s = await st(); if (s.contact) break; await sleep(p, 100); }
  await p.keyboard.up('d');
  if (!s.contact) await fail('没有发生接触战斗');
  console.log('contact with', foe, s);
  await sleep(p, 1500);
  const s1 = await st();
  await p.screenshot({ path: path.join(OUT, 'v05-contact.png') });
  if (!(s1.n < s.n || !s1.inBattle)) await fail('接触中兵数没有减少');
  if (!logs.some(l => l.startsWith('[battle-start]'))) await fail('没有 battle-start 日志');
  // 战斗中刷新页面 → 标题“继续游戏” → 战斗快照恢复（还在交战、兵数一致）
  await sleep(p, 1100); // 等下一次 battle-snapshot（每 1 s）
  const before = await st();
  await p.reload(); await sleep(p, 2500);
  if (await p.evaluate(() => window.__game?.scene.isActive('Title'))) { await p.keyboard.press('Enter'); await sleep(p, 1200); }
  // save_v05.in_battle：读档回到战斗 → 暂停 + 3 s“继续战斗”倒计时
  const cd = await p.evaluate(() => ({ paused: __game.scene.isPaused('World'), text: __game.scene.getScene('UI').countdownUi?.text ?? null }));
  console.log('resume countdown', cd);
  if (!cd.paused || !/继续战斗/.test(cd.text || '')) await fail('读档回到战斗时没有暂停倒计时');
  t0 = Date.now(); while (Date.now() - t0 < 6000 && await p.evaluate(() => __game.scene.isPaused('World'))) await sleep(p, 100);
  const restored = await st();
  console.log('reload', { before: before.n, restored: restored.n, inBattle: restored.inBattle });
  if (!restored.inBattle) await fail('读档后战斗没有恢复');
  if (Math.abs(restored.n - before.n) > 3) await fail(`读档后兵数差太多 ${before.n} → ${restored.n}`);
  await p.mouse.click(550, 600); await sleep(p, 100);
  // 开走：往左（远离敌人）一直开，直到脱离（escape）或战斗以别的方式结束
  await p.keyboard.down('a');
  t0 = Date.now(); let shot = false, sawApartHud = false;
  const hud = () => p.evaluate(() => __game.scene.getScene('UI').info.text);
  while (Date.now() - t0 < 30000) {
    s = await st();
    if (!sawApartHud && /脱离 \d+\.\d\/\d+(\.\d+)?s/.test(await hud())) sawApartHud = true; // QA-15：HUD 脱离进度
    if (!shot && !s.contact && s.pairs) { await p.screenshot({ path: path.join(OUT, 'v05-disengaging.png') }); shot = true; }
    // 可能有第三方加入：要等所有交战都结束（逃脱 / 别的方式）
    if (!s.inBattle && (logs.some(l => l.startsWith('[escape] 主角军')) || logs.some(l => l.startsWith('[battle-end]')))) break;
    await sleep(p, 200);
  }
  await p.keyboard.up('a');
  await sleep(p, 300);
  s = await st();
  await p.screenshot({ path: path.join(OUT, 'v05-after.png') });
  const escaped = logs.some(l => l.startsWith('[escape] 主角军'));
  console.log('after', s, logs.filter(l => /^\[(battle|escape|draw|rout)/.test(l)));
  if (!escaped) await fail('玩家开走后没有脱离（escape）');
  if (!s.prot) await fail('脱离后没有 8 s 保护');
  if (!sawApartHud) await fail('QA-15：拉开过程中 HUD 没出现「脱离 x/2s」');
  const hudAfter = await hud();
  if (!/保护\d+\.\ds/.test(hudAfter)) await fail('QA-15：脱离后 HUD 没有「保护 Ns」：' + hudAfter.split('\n').slice(0, 3).join(' | '));
  if (!logs.some(l => l.startsWith('[fx] escape'))) await fail('QA-15：没有「脱离」飘字');
  console.log('QA-15 HUD ok', { sawApartHud, prot: hudAfter.match(/保护\d+\.\ds/)?.[0] });
  if (s.inBattle) await fail('脱离后仍在交战');
  if (errs.length) await fail('页面错误: ' + errs.join(' | '));
  console.log('SMOKE v0.5 OK');
  await b.close();
})();
