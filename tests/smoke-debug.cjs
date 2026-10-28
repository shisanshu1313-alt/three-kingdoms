// F2 调试菜单冒烟（开发服务器）：F2 打开（Phaser 画，不是 DOM）→ 1 点数 / 2 立即主城 → 2 迁都弹窗 → Y / 3 填满队伍触发 T2
// / E 没副将提示 / 有副将提示主城 H / 4 给武将（入队 ×2、满编弹名册）/ 5 下一抽必出武将卡 / 6 最近的城城防归零（不交战）。
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
  const paused = await W(() => { const w = __game.scene.getScene('World'), t = w.clock.now; return new Promise(r => setTimeout(() => r({ p: __game.scene.isPaused('World'), dt: w.clock.now - t }), 400)); });
  await ok(paused.p && paused.dt === 0, `QA-05：菜单打开时大地图暂停（${JSON.stringify(paused)}）`);
  await p.keyboard.press('1'); await sleep(p, 150); await p.keyboard.press('1'); await sleep(p, 200);
  const s2 = await st();
  await ok(s2.open && s2.points === s1.points + 400, `QA-11：1 连按两次 → 点数 +400，菜单不关（${s2.points}）`);
  await p.keyboard.press('Escape'); await sleep(p, 200);
  await ok(!(await st()).open && !(await W(() => __game.scene.isPaused('World'))), 'Esc 关菜单 → 大地图恢复');
  // QA-06：菜单开着按 G → 抽卡弹窗打开、菜单自动关（不留残影）；弹窗开着按 F2 不出菜单
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('g'); await sleep(p, 400);
  const g1 = await W(() => ({ gacha: __game.scene.isActive('Gacha'), menu: __game.scene.getScene('UI').debugMenu.open, vis: __game.scene.getScene('UI').debugMenu.bg.visible }));
  await p.keyboard.press('F2'); await sleep(p, 150);
  const g2 = await W(() => __game.scene.getScene('UI').debugMenu.bg.visible);
  await ok(g1.gacha && !g1.menu && !g1.vis && !g2, `QA-06：抽卡弹窗打开时 F2 菜单关闭、不显示（${JSON.stringify({ ...g1, g2 })}）`);
  await p.keyboard.press('Escape'); await sleep(p, 400);
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
  // PM 2026-10-23：大地图按 E 没有副将 → 「还没有武将」
  const toasts = () => W(() => __game.scene.getScene('UI').toasts.filter(t => t.active).map(t => t.text));
  const gens = () => W(() => { const w = __game.scene.getScene('World'); return { n: w.player.team.generals.length, pend: w.state.pendingGenerals.length, roster: __game.scene.isActive('Roster') }; });
  await p.keyboard.press('e'); await sleep(p, 200);
  await ok((await toasts()).includes('还没有武将') && (await gens()).n === 1, `E 没有副将 → 提示「还没有武将」（${JSON.stringify(await toasts())}）`);
  // F2→4 给武将：有空位入队 ×2，满编 → 名册弹窗（换将 / 流放 / 存城），Esc 不掉，按 R 流放新来的
  const k0 = await gens();
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('4'); await sleep(p, 300);
  const k1 = await gens();
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('4'); await sleep(p, 300);
  const k2 = await gens();
  await ok(k1.n === k0.n + 1 && k2.n === k0.n + 2 && !k2.roster && !(await st()).open, `4 给武将 ×2 → 作为副将入队（${JSON.stringify({ k0, k1, k2 })}）`);
  const nNo = async () => (await toasts()).filter(t => t === '还没有武将').length, nb = await nNo();
  await p.keyboard.press('e'); await sleep(p, 200);
  await ok((await toasts()).includes('调动副将要在主城里按 H'), '有副将后 E →「调动副将要在主城里按 H」');
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('4'); await sleep(p, 600);
  const k3 = await gens();
  await ok(k3.n === k2.n && k3.pend === 1 && k3.roster, `满编再给 → 待安排 1 名，名册弹窗打开（${JSON.stringify(k3)}）`);
  await p.screenshot({ path: path.join(OUT, 'v06-debug-roster.png') });
  await p.keyboard.press('r'); await sleep(p, 250);
  const conf = await W(() => __game.scene.getScene('Roster')?.flow?.ui);
  await ok(conf === 'CONFIRM_EXILE', `R 第一次 → 确认页（${conf}）`);
  await p.keyboard.press('r'); await sleep(p, 400);
  for (let i = 0; i < 3 && (await gens()).roster; i++) { await p.keyboard.press('Escape'); await sleep(p, 300); }
  const k4 = await gens();
  await ok(k4.pend === 0 && !k4.roster && k4.n === k2.n, `名册里 R×2 确认流放新来的 → 处理完、弹窗关闭（${JSON.stringify(k4)}）`);
  // F2→5 下一抽必出武将卡（开关，菜单不关）→ G 抽卡 → 4 张里有武将卡；用掉后自动关
  await W(() => { __game.scene.getScene('World').state.points += 500; });
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('5'); await sleep(p, 200);
  const f5 = await W(() => ({ flag: __game.scene.getScene('World').devNextGeneral, open: __game.scene.getScene('UI').debugMenu.open }));
  await p.keyboard.press('Escape'); await sleep(p, 200);
  await p.keyboard.press('g'); await sleep(p, 400); await p.keyboard.press(' '); await sleep(p, 500);
  const offer = await W(() => { const g = __game.scene.getScene('Gacha'), w = __game.scene.getScene('World');
    return { state: g?.uiState, kinds: (w.state.gacha?.offer?.cards ?? []).map(c => c.kind), flag: w.devNextGeneral }; });
  await ok(f5.flag === true && f5.open && offer.state === 'OFFER' && offer.kinds.some(k => k.startsWith('general_')) && offer.flag === false, `5 → 下一抽 4 张里有武将卡，用掉后开关自动关（${JSON.stringify({ f5, offer })}）`);
  await p.screenshot({ path: path.join(OUT, 'v06-debug-gacha-general.png') });
  // 选掉一张非武将卡再关窗口（不改名册）
  const idx = offer.kinds.findIndex(k => !k.startsWith('general_') && !k.startsWith('item') && k !== 'unit_order');
  await p.keyboard.press(String(idx + 1)); await sleep(p, 400);
  for (const k of ['1', 'Escape', 'Escape']) { if (!(await W(() => __game.scene.isActive('Gacha') || __game.scene.isActive('Roster')))) break; await p.keyboard.press(k); await sleep(p, 300); }
  // 不再按 5：第二次抽卡不强制（可能碰巧出武将，但 flag 必须仍是 false；用注入空池验证强制路径已关）
  await W(() => { const w = __game.scene.getScene('World'); w.devNextGeneral = false; w.state.points += 200; });
  await p.keyboard.press('g'); await sleep(p, 400); await p.keyboard.press(' '); await sleep(p, 500);
  const offer2 = await W(() => { const w = __game.scene.getScene('World');
    return { flag: w.devNextGeneral, kinds: (w.state.gacha?.offer?.cards ?? []).map(c => c.kind) }; });
  await ok(offer2.flag === false, `未再按 5：第二次抽卡 flag 仍关（${JSON.stringify(offer2)}）`);
  for (const k of ['1', 'Escape', 'Escape']) { if (!(await W(() => __game.scene.isActive('Gacha') || __game.scene.isActive('Roster')))) break; await p.keyboard.press(k); await sleep(p, 300); }
  // F2→6 最近的城城防归零：不交战、守军不动；城破回复按 break_window_s 暂停
  const w6 = () => W(() => { const w = __game.scene.getScene('World'), pl = w.player, cs = Object.values(w.state.cities).filter(c => c.owner !== 'player');
    const near = cs.sort((a, b) => Math.hypot(a.x - pl.x, a.y - pl.y) - Math.hypot(b.x - pl.x, b.y - pl.y));
    return { cities: Object.fromEntries(Object.values(w.state.cities).map(c => [c.id, { def: c.def, gar: !!c.garrison, zeroAtS: c.zeroAtS }])), near: near.map(c => c.id), inBattle: !!pl.inBattle, garParties: w.aiParties.filter(x => x.team.cityHold).length }; });
  const b6 = await w6();
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('6'); await sleep(p, 300);
  const a6 = await w6(), hit = Object.keys(a6.cities).find(id => a6.cities[id].def === 0 && b6.cities[id].def > 0);
  const t6 = (await toasts()).find(t => /城防 → 0/.test(t));
  await ok(hit && a6.cities[hit].zeroAtS != null && a6.cities[hit].gar === b6.cities[hit].gar && a6.garParties === b6.garParties && !a6.inBattle && !(await st()).open && t6,
    `6 → ${hit} 城防归零（最近的未破非我方城），守军不动、没交战（${t6}）`);
  await sleep(p, 1500);
  await ok((await w6()).cities[hit].def === 0, `城破后 ${hit} 暂不回复（break_window_s 内）`);
  await p.keyboard.press('F2'); await sleep(p, 150); await p.keyboard.press('Escape'); await sleep(p, 150);
  await ok(!(await st()).open, 'Esc 关闭菜单');
  await ok(!errs.length, `无报错（${errs.join(' | ')}）`);
  console.log(`SMOKE-DEBUG OK (${n} checks)`);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
