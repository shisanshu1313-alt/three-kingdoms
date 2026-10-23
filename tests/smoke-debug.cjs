// F2 调试菜单冒烟（开发服务器）：F2 打开（Phaser 画，不是 DOM）→ 1 点数 / 2 立即主城 → 2 迁都弹窗 → Y / 3 填满队伍触发 T2。
// 用法：node tests/smoke-debug.cjs [url]（默认 http://localhost:5182/）；截图 artifacts/v06-debug-menu.png
const path = require('path');
const { chromium } = require(process.env.PW_PATH || process.env.PW_CORE || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5182/';
const OUT = path.join(__dirname, '..', 'artifacts');
const sleep = (p, ms) => p.waitForTimeout(ms);
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [], logs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { logs.push(m.text()); if (m.type() === 'error') errs.push(m.text()); });
  let n = 0;
  const ok = async (cond, msg) => {
    if (cond) { n++; console.log('ok', n, '-', msg.split('（')[0]); return; }
    console.error('FAIL:', msg); console.error(logs.slice(-25).join('\n'));
    await p.screenshot({ path: path.join(OUT, 'debug-fail.png') }); await b.close(); process.exit(1);
  };
  const W = (fn, arg) => p.evaluate(fn, arg);
  await p.goto(URL); await W(() => localStorage.clear()); await p.reload(); await sleep(p, 2500);
  if (await W(() => window.__game?.scene.isActive('Title'))) await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.__game?.scene.getScene('UI')?.debugMenu && window.__game.scene.getScene('World')?.player, null, { timeout: 15000 });
  await W(() => { const w = __game.scene.getScene('World'); w.run.raidDone = true; w.run.heroHp = 1e9; w.player.invincibleUntil = w.clock.now + 3600e3; });
  const st = () => W(() => { const w = __game.scene.getScene('World'), u = __game.scene.getScene('UI'), m = u.debugMenu;
    return { open: m.open, vis: m.text.visible, text: m.text.text, dom: document.querySelectorAll('body *:not(canvas):not(script)').length, points: w.state.points, home: w.state.homeCity,
      lyOwner: w.state.cities.luoyang.owner, gar: w.aiParties.filter(x => x.team.cityHold).length, prompt: !!u.cityPrompt, teams: w.aiParties.length, max: window.__balance.spawn.max_ai_teams, stale: w.staleRemoved ?? 0 }; });
  const s0 = await st();
  await p.keyboard.press('F2'); await sleep(p, 200);
  const s1 = await st();
  await ok(s1.open && s1.vis && /调试菜单/.test(s1.text) && !s0.open, `F2 打开调试菜单（Phaser 文本）（${JSON.stringify(s1)}）`);
  await p.screenshot({ path: path.join(OUT, 'v06-debug-menu.png') });
  await p.keyboard.press('1'); await sleep(p, 200);
  const s2 = await st();
  await ok(!s2.open && s2.points === s1.points + 200, `1 点数 +200 并关闭（${s2.points}）`);
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('2'); await sleep(p, 300);
  const s3 = await st();
  await ok(s3.home === 'luoyang' && s3.lyOwner === 'player' && s3.gar === 0, `2 立即获得主城（洛阳，守军撤掉）（${JSON.stringify(s3)}）`);
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('2'); await sleep(p, 300);
  const s4 = await st();
  await ok(s4.prompt && s4.home === 'luoyang', `再按 2 → 迁都弹窗（${JSON.stringify(s4)}）`);
  await p.keyboard.press('y'); await sleep(p, 300);
  const s5 = await st();
  await ok(!s5.prompt && s5.home && s5.home !== 'luoyang' && s5.lyOwner == null, `Y 迁都：旧主城洛阳变无主（${JSON.stringify(s5)}）`);
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('3'); await sleep(p, 300);
  const s6 = await st();
  const t2 = logs.filter(l => /撤下过弱队/.test(l)).length;
  await ok(s6.teams === s6.max && !s6.open, `3 填满地图队伍 ${s6.teams}/${s6.max}（T2 撤下 ${s6.stale - s5.stale} 支，日志 ${t2} 条）`);
  // T2 规则本身：再把所有黄巾队设成很弱、远离玩家 → 再填一次必撤 1 支
  await W(() => { const w = __game.scene.getScene('World'); for (const q of w.aiParties) if (q.faction === 'bandit' && !q.team.cityHold) { q.team.soldiers = 1; q.refresh(); w.field.refresh(q); w.field.teleport(q, w.player.x + 900, w.player.y); } });
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('3'); await sleep(p, 300);
  const s7 = await st();
  await ok(s7.stale === s6.stale + 1 && s7.teams === s7.max && logs.some(l => /撤下过弱队/.test(l)), `满员 + 有过弱黄巾队 → T2 撤下 1 支再补（${JSON.stringify({ s6: s6.stale, s7: s7.stale, teams: s7.teams })}）`);
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('Escape'); await sleep(p, 150);
  await ok(!(await st()).open, 'Esc 关闭菜单');
  await ok(!errs.length, `无报错（${errs.join(' | ')}）`);
  console.log(`SMOKE-DEBUG OK (${n} checks)`);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
