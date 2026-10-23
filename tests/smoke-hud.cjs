// HUD 属性面板冒烟：常显小面板 → C 展开详情 → 属性 / 武将变化实时刷新并高亮 → 点按钮收起（不触发寻路）→ 竖屏布局。
// 用法：node tests/smoke-hud.cjs [url]（默认 http://localhost:5181/）
// 截图：/workspace/hud-stats-screenshot.png（横屏，小面板 + 详情）、/workspace/hud-stats-portrait.png（竖屏 390×844）
const path = require('path');
const { chromium } = require(process.env.PW_CORE || process.env.PW_PATH || '/workspace/.tools/node_modules/playwright-core');
const URL = process.argv[2] || 'http://localhost:5181/';
const SHOT = process.env.HUD_SHOT || '/workspace/hud-stats-screenshot.png';
const SHOT_P = process.env.HUD_SHOT_PORTRAIT || '/workspace/hud-stats-portrait.png';
const OUT = path.join(__dirname, '..', 'artifacts');
(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [], logs = [];
  p.on('pageerror', e => errs.push(String(e)));
  p.on('console', m => { logs.push(m.text()); if (m.type() === 'error') errs.push(m.text()); });
  const fail = async (msg) => { console.error('FAIL:', msg); console.error(logs.slice(-30).join('\n')); await p.screenshot({ path: path.join(OUT, 'hud-fail.png') }); await b.close(); process.exit(1); };
  const ok = async (c, msg) => (c ? console.log('ok  ', msg) : fail(msg));
  const W = (fn, a) => p.evaluate(fn, a);
  const snap = () => W(() => __game.scene.getScene('UI').stats.snapshot());
  const wait = ms => p.waitForTimeout(ms);

  await p.goto(URL); await W(() => localStorage.clear()); await p.reload();
  await p.waitForFunction(() => window.__game?.scene.isActive('Title'), null, { timeout: 15000 });
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => window.__game.scene.getScene('World')?.player && window.__game.scene.getScene('UI')?.stats, null, { timeout: 15000 });
  await wait(400);
  // 让玩家不受打扰：关掉开局遭遇战，无敌
  await W(() => { const w = __game.scene.getScene('World'); w.run.raidDone = true; w.player.invincibleUntil = w.clock.now + 600000; });

  // 1) 常显小面板：统帅（= 主角）+ 四维
  let s = await snap();
  const hero = await W(() => { const g = __game.scene.getScene('World').player.team.generals.find(x => x.id === 'hero'); return { lead: g.lead, str: g.str, int: g.int, cha: g.cha }; });
  const cj = s.compact.join(' | ');
  await ok(!s.open && cj.includes(`统率 ${hero.lead}`) && cj.includes(`武力 ${hero.str}`) && cj.includes(`智力 ${hero.int}`) && cj.includes(`魅力 ${hero.cha}`) && /^统帅\s+主角/.test(s.compact[0]) && !cj.includes('主将'), `小面板常显：统帅 = 主角 + 四维（${cj}）`);

  // 2) C 展开详情（按住自动重复不来回切换）
  await p.keyboard.down('c'); await p.keyboard.down('c', { repeat: true }); await p.keyboard.down('c', { repeat: true }); await p.keyboard.up('c'); await wait(200);
  s = await snap();
  const dj = s.detail.join('\n');
  await ok(s.open && /兵力上限 \d+/.test(dj) && /智力减伤 [\d.]+%/.test(dj) && /魅力收编率 [\d.]+%/.test(dj) && /战力 \d+/.test(dj) && /^统帅 主角/m.test(dj) && !dj.includes('主将'), `C 展开详情：\n${dj}`);
  const cap0 = await W(() => __game.scene.getScene('World').player.cap);
  await ok(dj.includes(`兵力上限 ${cap0}`), `详情兵力上限 = player.cap（${cap0}）`);
  const paused = await W(() => __game.scene.isPaused('World'));
  await ok(!paused, '详情打开时大地图不暂停');

  // 3) 实时刷新：属性卡（主角智力 +6）→ 智力减伤变化并高亮；得到武将（张飞）→ 统帅仍是主角、张飞为副将，注明结算按统率最高者
  await W(() => { const w = __game.scene.getScene('World'); w.player.team.generals.find(g => g.id === 'hero').int += 6; w.player.refresh(); });
  await wait(100);
  s = await snap();
  await ok(s.highlighted.includes('intRed') && s.highlighted.includes('hero.int') && s.compact.join(' ').includes(`智力 ${hero.int + 6}`), `属性卡后刷新并高亮（${s.highlighted.join(',')}）`);
  await W(() => { const w = __game.scene.getScene('World'), g = window.__balance.generals.find(x => x.id === 'zhangfei'); const t = w.player.team;
    if (t.generals.length >= 3) t.generals.pop();
    t.generals.push({ id: g.id, name: g.name, tier: g.tier, lead: g.lead, str: g.str, int: g.int, cha: g.cha }); w.player.refresh(); w.field.refresh(w.player); });
  await wait(150);
  s = await snap();
  await ok(/^统帅\s+主角/.test(s.compact[0]) && /按 张飞 统率 85/.test(s.compact[3] ?? '') && s.highlighted.includes('main.id') && s.highlighted.includes('cap') && s.detail.some(l => l.startsWith('副将 张飞')) && s.detail.some(l => l.includes('现按统率最高者 张飞')), `得到张飞：统帅仍是主角，副将 张飞，注明结算按统率最高者（${s.compact.join(' | ')}）`);
  await p.screenshot({ path: SHOT });
  console.log('shot', SHOT);
  await wait(1700);
  s = await snap();
  await ok(s.highlighted.length === 0, `高亮约 1.5 s 后消失（${s.highlighted.join(',')} / last ${s.lastChanged.join(',')}）`);

  // 4) 点 [收起 C] 按钮：收起详情，玩家不寻路
  const btn = await W(() => { const st = __game.scene.getScene('UI').stats; return { x: st.btn.x + 37, y: st.btn.y + 17 }; });
  await p.mouse.click(btn.x, btn.y); await wait(250);
  s = await snap();
  const path0 = await W(() => !!__game.scene.getScene('World').player.path);
  await ok(!s.open && !path0, `点按钮收起详情、不触发寻路（open=${s.open}, path=${path0}）`);
  await p.mouse.click(btn.x, btn.y); await wait(250);
  await ok((await snap()).open, '再点按钮展开（触屏入口）');

  // 5) 竖屏 390×844：布局适配、在屏内
  await p.setViewportSize({ width: 390, height: 844 }); await wait(600);
  const geo = await W(() => { const u = __game.scene.getScene('UI'), st = u.stats; return { w: u.scale.width, h: u.scale.height, L: st.L, dx: st.detail.x, dy: st.detail.y, dh: st.detailH, cx: st.compact.x, ch: st.compactH }; });
  await ok(geo.L.portrait && geo.dx >= 0 && geo.dx + geo.L.detail.w <= geo.w && geo.dy >= 0 && geo.dy + geo.dh <= geo.h && geo.cx >= 0 && geo.L.compact.font < 13, `竖屏布局在屏内（${JSON.stringify({ w: geo.w, h: geo.h, dx: geo.dx, dy: geo.dy, dh: geo.dh, font: geo.L.compact.font })}）`);
  await p.screenshot({ path: SHOT_P });
  console.log('shot', SHOT_P);
  await p.keyboard.press('c'); await wait(200);
  await ok(!(await snap()).open, '竖屏 C 收起');
  await p.screenshot({ path: path.join(OUT, 'hud-portrait-compact.png') });

  await ok(errs.length === 0, `无报错（${errs.slice(0, 3).join(' / ')}）`);
  console.log('SMOKE-HUD OK');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
