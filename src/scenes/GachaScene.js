import { createSceneInput, ACTIONS } from '../platform/input.js';
import Phaser from 'phaser';
import { balance } from '../data/index.js';
import { UNIT_ORDER_UNITS, describeItem, ATTR_NAMES } from '../systems/gacha.js';
import { canOpen, openDraw, refreshInfo, refreshOffer, pickCard, previewCard, gachaState, drawCost, threatUnits, cardTitle, generalOf, RARITY_NAMES, KIND_NAMES } from '../systems/gachaOffer.js';
import { getLeader } from '../systems/leader.js';
import { computePower } from '../systems/combat.js';
import { scoutRange } from '../systems/scouting.js';
import { UNIT_FULL_NAMES } from '../systems/units.js';
import { button, text, generalLine, tierColor } from '../ui/widgets.js';

import { gachaLayout, PANEL_WIDE, PANEL_NARROW } from '../ui/gachaLayout.js';
export { gachaLayout, PANEL_WIDE, PANEL_NARROW };
export const RARITY_FRAME = { epic: 0xf1c40f, rare: 0x3498db, common: 0x8a8f98 }; // gacha_v06.rarity.frame：金 / 蓝 / 灰
const AFF = balance.v05?.units?.affinity?.table ?? {};

/**
 * v0.6 抽卡（gacha_v06.flow）：付费 → 4 张选 1 → 结算 → 自动存档。打开时大地图暂停；战斗中不能抽。
 * 状态：IDLE（未抽）/ OFFER（4 张）/ ITEM_FULL（选丢弃，可返回）/ CHOOSE_UNIT（兵种令，可返回）/ ROSTER_FULL（名册弹窗）/ RESULT
 * offer 生成后立即存档：刷新页面回到同一组 4 张。OFFER 时不能关闭（必须选 1 张）。
 * 键盘：空格 / Enter 抽卡（IDLE、RESULT）；1~4 选卡；F 换一批；ITEM_FULL 1~3 丢弃；CHOOSE_UNIT 1~4 兵种；Esc 返回 / 关闭。
 */
export default class GachaScene extends Phaser.Scene {
  constructor() { super('Gacha'); }

  init() { this.world = this.scene.get('World'); this.uiState = 'IDLE'; this.result = null; this.message = ''; this.sel = null; }

  create() {
    this.frame = this.add.container(0, 0); // 遮罩 + 面板底框 + 标题（applyLayout 按屏幕尺寸重画）
    this.dyn = this.add.container(0, 0);
    this.applyLayout();
    const act = createSceneInput(this, { pointer: false });
    act.on(ACTIONS.CANCEL, () => this.onCancel());
    act.on(ACTIONS.CONFIRM, () => this.onPrimary());
    act.on(ACTIONS.PRIMARY, () => this.onPrimary());
    act.on(ACTIONS.CHOOSE, ({ n }) => this.onChoose(n));
    act.on(ACTIONS.REFRESH, () => this.doRefresh());
    const onResume = () => this.afterRoster();
    this.events.on('resume', onResume);
    // 弹窗开着时转屏 / 改窗口大小 → 重新选布局（横 4 列 / 竖 2×2）、缩放、重画（QA a7d1348 复测 §5.3）
    const onResize = () => { if (this.frame?.scene) { this.applyLayout(); this.render(); } };
    this.scale.on('resize', onResize);
    this.events.once('shutdown', () => { this.scale.off('resize', onResize); this.events.off('resume', onResume); });
    if (gachaState(this.st).offer) this.uiState = 'OFFER'; // 读档：回到同一组 4 张
    this.render();
  }

  /** 按当前屏幕尺寸算布局（ui/gachaLayout.js）、设镜头缩放、重画底框；卡片 / 按钮由 render() 按 this.ox/oy/layout 画 */
  applyLayout() {
    const { width, height } = this.scale, L = this.layout = gachaLayout(width, height);
    this.W = L.W; this.H = L.H; this.ox = L.ox; this.oy = L.oy;
    this.cameras.main.setSize(width, height).setZoom(L.s).centerOn(L.vw / 2, L.vh / 2);
    this.frame.removeAll(true);
    this.frame.add(this.add.rectangle(0, 0, L.vw, L.vh, 0x000000, 0.6).setOrigin(0).setInteractive());
    this.frame.add(this.add.rectangle(this.ox, this.oy, this.W, this.H, 0x1b1f2a, 0.97).setOrigin(0).setStrokeStyle(2, 0xf1c40f));
    this.frame.add(text(this, this.ox + 20, this.oy + 12, '抽卡 · 四选一', 22, '#f1c40f'));
  }

  get st() { return this.world.state; }
  get team() { return this.world.player.team; }
  get chapter() { return this.world.run?.chapter ?? 0; }

  /** ctx：章节 + 侦察范围内克制我方兵种的敌队（chapter_fit.threat_def） */
  ctx() {
    const pl = this.world.player, range = scoutRange(pl.team, balance).scout;
    const enemies = (this.world.parties ?? []).filter(p => !p.isPlayer && p.team?.faction !== pl.team.faction).map(p => ({ unit: p.team.unit, dist: Math.hypot(p.x - pl.x, p.y - pl.y) }));
    return { inBattle: !!pl.inBattle, chapter: this.chapter, threat: threatUnits(pl.team.unit, enemies, range, this.world.field.cfg.move.counters), atS: (this.world.clock?.now ?? 0) / 1000 };
  }

  onCancel() {
    if (this.uiState === 'ITEM_FULL' || this.uiState === 'CHOOSE_UNIT') { this.uiState = 'OFFER'; this.sel = null; return this.render(); }
    if (this.uiState === 'IDLE' || this.uiState === 'RESULT') return this.close();
  }
  onPrimary() { if (this.uiState === 'IDLE' || this.uiState === 'RESULT') this.doOpen(); }
  onChoose(n) {
    if (this.uiState === 'OFFER' && n >= 1 && n <= gachaState(this.st).offer.cards.length) return this.pick(n - 1);
    if (this.uiState === 'ITEM_FULL' && n >= 1 && n <= this.team.items.length) return this.pick(this.sel, { discard: n - 1 });
    if (this.uiState === 'CHOOSE_UNIT' && n >= 1 && n <= UNIT_ORDER_UNITS.length) return this.pick(this.sel, { unit: UNIT_ORDER_UNITS[n - 1] });
  }

  close() { this.scene.stop(); this.game.events.emit('modal-closed', 'Gacha'); }

  saved(reason = 'gacha') { this.world.player.refresh(); this.world.field?.refresh?.(this.world.player); this.world.trySaveNow(reason); }

  doOpen() {
    const ctx = this.ctx(), chk = canOpen(this.st, this.team, balance, ctx);
    if (!chk.ok) { this.message = chk.text; return this.render(); }
    const o = openDraw(this.st, this.team, balance, this.world.rngs.gacha, ctx);
    this.saved();
    console.log(`[gacha] -${o.cost} offer ${o.cards.map(c => `${c.kind}(${c.rarity})`).join(' ')}`);
    this.message = ''; this.result = null; this.uiState = 'OFFER';
    this.render(); this.flashEpic();
  }

  doRefresh() {
    if (this.uiState !== 'OFFER') return;
    const info = refreshInfo(this.st, balance, this.chapter);
    if (!info.ok) { this.message = info.text; return this.render(); }
    refreshOffer(this.st, this.team, balance, this.world.rngs.gacha, this.ctx());
    this.saved();
    console.log(`[gacha] refresh -${info.cost}`);
    this.message = ''; this.render(); this.flashEpic();
  }

  pick(i, opts = {}) {
    const r = pickCard(this.st, this.team, i, balance, this.world.rngs.gacha, { ...opts, atS: this.ctx().atS });
    if (r.next === 'item_full' || r.next === 'choose_unit') { this.sel = i; this.uiState = r.next === 'item_full' ? 'ITEM_FULL' : 'CHOOSE_UNIT'; return this.render(); }
    this.sel = null; this.result = r;
    this.saved();
    console.log(`[gacha] pick ${r.card.kind} ${r.text}`);
    if (r.next === 'roster_full') { this.uiState = 'ROSTER_FULL'; this.render(); return this.openRoster(); }
    this.uiState = 'RESULT'; this.render();
  }

  openRoster() { this.scene.launch('Roster', { returnTo: 'Gacha' }); this.scene.bringToTop('Roster'); this.scene.pause(); }
  afterRoster() {
    if (this.uiState === 'ROSTER_FULL') {
      const last = this.st.lastRosterText;
      if (last) this.result.text = `${this.result.text} → ${last}`;
      this.result.powerAfter = computePower(this.team, balance);
      this.uiState = 'RESULT';
    }
    this.render();
  }

  /** 高阶卡出卡动画：金框闪烁放大 */
  flashEpic() {
    for (const f of this.epicFrames ?? []) this.tweens.add({ targets: f, scaleX: 1.04, scaleY: 1.04, alpha: 0.6, yoyo: true, repeat: 2, duration: 160 });
  }

  /** 一张卡的文案行 */
  cardLines(card) {
    const t = this.team, lines = [];
    if (card.kind.startsWith('general_')) {
      const g = generalOf(card, balance);
      lines.push(`统${g.lead} 武${g.str} 智${g.int} 魅${g.cha}`);
      lines.push(`擅长：${UNIT_FULL_NAMES[AFF[g.id]] ?? '无'}`);
    } else if (card.kind === 'attr_s' || card.kind === 'attr_b') {
      const g = t.generals.find(x => x.id === card.target.generalId);
      lines.push(`${g?.name ?? '?'}`, `${ATTR_NAMES[card.target.attr]} ${g?.[card.target.attr]} → ${Math.min(balance.v06.gacha.cards.attr_s.cap, (g?.[card.target.attr] ?? 0) + card.amount)}`);
    } else if (card.kind.startsWith('troops')) {
      lines.push(`立刻 +${card.amount} 兵`, `（超过上限作废）`);
    } else if (card.kind.startsWith('item')) {
      const it = balance.items.find(i => i.id === card.target.itemId);
      lines.push(describeItem(it) || (it.effect?.dmg_taken_from ? `受${Object.keys(it.effect.dmg_taken_from).map(u => UNIT_FULL_NAMES[u]).join('')}伤害 −${Math.round(Object.values(it.effect.dmg_taken_from)[0] * 100)}%` : it.effect?.scout_px ? `侦察 +${it.effect.scout_px}` : ''));
    } else if (card.kind === 'unit_order') {
      lines.push('选完后选全队兵种', '（选了就算用掉）');
    } else if (card.kind === 'drill') {
      lines.push(`克制倍率 +${card.amount}`, `本局 ${this.st.drillUsed ?? 0}/${balance.v06.gacha.drill_max}，换兵种清零`);
    } else {
      const c = balance.v06.gacha.cards[card.kind];
      lines.push({ ep_attr: `全队统率、武力 +${c.amount}`, ep_troops: `兵力上限 +${c.cap_add}，补满`, ep_power: `战力系数 M +${c.m_add}（不占物品栏）`, ep_counter: `克制倍率 +${c.counter_add}（换兵种不清零）` }[card.kind]);
    }
    return lines;
  }

  render() {
    this.dyn.removeAll(true); this.epicFrames = []; this.openBtn = null;
    const add = o => { this.dyn.add(o); return o; };
    const st = this.st, team = this.team, gs = gachaState(st), x0 = this.ox + 20, P = Math.round, W = this.W, H = this.H, wide = this.layout.cols === 4;
    const cost = drawCost(gs.n, balance), dy = wide ? 0 : 40; // 窄屏：表头换行多，正文下移
    add(text(this, wide ? this.ox + 220 : x0, this.oy + (wide ? 16 : 40), `点数 ${st.points}   下一抽 ${cost} 点   已抽 ${gs.n} 次   第 ${this.chapter + 1} 章`, 15, '#dddddd'));
    const lead = getLeader(team, balance);
    add(text(this, x0, this.oy + 46, `队伍：${team.generals.map(g => (g === lead ? `★${g.name}` : g.name)).join('、')}   兵 ${team.soldiers}/${P(this.world.player.cap)}   ${UNIT_FULL_NAMES[team.unit] ?? ''}   战力 ${P(computePower(team, balance))}   物品 ${team.items.map(id => balance.items.find(i => i.id === id)?.name).join('、') || '无'}`, 13, '#aaaaaa', { wordWrap: { width: W - 40 } }).setY(this.oy + (wide ? 46 : 62)));
    const by = this.oy + H - 62;

    if (this.uiState === 'IDLE' || this.uiState === 'RESULT') {
      const chk = canOpen(st, team, balance, this.ctx());
      if (this.result) {
        const r = this.result, c = r.card;
        add(this.add.rectangle(x0, this.oy + dy + 90, W - 40, 150, 0x262b38).setOrigin(0).setStrokeStyle(3, RARITY_FRAME[c.rarity]));
        add(text(this, x0 + 16, this.oy + dy + 102, `选了：${cardTitle(c, balance)}（${RARITY_NAMES[c.rarity]}）`, 18, '#' + RARITY_FRAME[c.rarity].toString(16).padStart(6, '0')));
        add(text(this, x0 + 16, this.oy + dy + 134, r.text, 15, '#ffffff', { wordWrap: { width: W - 80 } }));
        add(text(this, x0 + 16, this.oy + dy + 170, `战力 ${P(r.powerBefore)} → ${P(r.powerAfter)}`, 16, r.powerAfter >= r.powerBefore ? '#66ee66' : '#ff8866'));
        if (c.rarity === 'epic') add(text(this, x0 + 16, this.oy + dy + 200, `高阶：${this.cardLines(c).join('；')}`, 14, '#f1c40f'));
      } else {
        add(text(this, x0, this.oy + dy + 100, '付费后出 4 张卡，选 1 张（每张标明效果和战力变化）。', 15, '#dddddd', { wordWrap: { width: W - 40 } }));
        const pr = balance.v06.gacha.rarity_by_chapter[Math.min(this.chapter, 3)];
        add(text(this, x0, this.oy + 128, `每张：普通 ${P(pr[0] * 100)}% / 稀有 ${P(pr[1] * 100)}% / 高阶 ${P(pr[2] * 100)}%；每章第 1 次换一批免费，之后 ${balance.v06.gacha.refresh.cost} 点`, 14, '#aaaaaa', { wordWrap: { width: W - 40 } }).setY(this.oy + dy + 128));
      }
      this.openBtn = add(button(this, x0, by, 260, 44, `抽卡（${cost} 点）[空格]`, () => this.doOpen(), { enabled: chk.ok, color: 0x8e5a00, size: 16 }));
      this.closeBtn = add(button(this, this.ox + W - (wide ? 180 : 170), by, wide ? 160 : 150, 44, '关闭 [Esc]', () => this.close()));
      const msg = this.message || (!chk.ok ? chk.text : '');
      if (msg) add(wide ? text(this, x0 + 280, by + 12, msg, 14, '#ff8888') : text(this, x0, by - 50, msg, 14, '#ff8888', { wordWrap: { width: W - 40 } }));
      return;
    }
    if (this.uiState === 'ROSTER_FULL') { add(text(this, x0, by, '队伍已满：请在弹窗中安排新武将', 15, '#ffdd55')); return; }

    // 4 张卡
    const offer = gs.offer, cw = 202, ch = 330, cy0 = this.oy + (wide ? 76 : 124), cols = this.layout.cols;
    this.cardRects = [];
    offer.cards.forEach((card, i) => {
      const cx = x0 + (i % cols) * (cw + 14), cy = cy0 + Math.floor(i / cols) * (ch + 14), frame = RARITY_FRAME[card.rarity], dim = this.sel !== null && this.sel !== i;
      const bg = add(this.add.rectangle(cx, cy, cw, ch, this.sel === i ? 0x34405a : 0x262b38).setOrigin(0).setStrokeStyle(card.rarity === 'common' ? 2 : 4, frame).setAlpha(dim ? 0.4 : 1));
      if (card.rarity === 'epic') this.epicFrames.push(bg);
      this.cardRects.push({ x: cx, y: cy, w: cw, h: ch });
      bg.setInteractive({ useHandCursor: true }).on('pointerdown', (p, lx, ly, ev) => { ev?.stopPropagation?.(); if (this.uiState === 'OFFER') this.pick(i); });
      add(text(this, cx + 10, cy + 8, `[${i + 1}]`, 14, '#ffffff'));
      add(text(this, cx + cw - 10, cy + 8, RARITY_NAMES[card.rarity], 13, '#' + frame.toString(16).padStart(6, '0')).setOrigin(1, 0));
      const isGen = card.kind.startsWith('general_');
      if (isGen) {
        const g = generalOf(card, balance);
        add(this.add.rectangle(cx + cw / 2 - 28, cy + 36, 56, 64, tierColor(g)).setOrigin(0).setStrokeStyle(2, 0xffffff));
        add(text(this, cx + cw / 2, cy + 68, g.tier, 26, '#000000').setOrigin(0.5));
      } else {
        add(text(this, cx + cw / 2, cy + 68, KIND_NAMES[card.kind] ?? (card.rarity === 'epic' ? '高阶' : ''), 14, '#888888').setOrigin(0.5));
      }
      add(text(this, cx + cw / 2, cy + 112, cardTitle(card, balance), 19, '#ffffff').setOrigin(0.5, 0));
      this.cardLines(card).forEach((l, k) => add(text(this, cx + 12, cy + 146 + k * 22, l, 13, '#dddddd', { wordWrap: { width: cw - 24 } })));
      const pv = previewCard(team, card, balance, st);
      if (pv.text && (isGen || pv.itemFull)) add(text(this, cx + 12, cy + 222, pv.text, 12, '#ffdd55', { wordWrap: { width: cw - 24 } }));
      const label = isGen ? (team.generals.length < balance.team_rules.max_generals ? '作为副将：战力' : '战力（最佳替换）') : '战力';
      add(text(this, cx + 12, cy + ch - 56, `${label}`, 12, '#aaaaaa'));
      add(text(this, cx + 12, cy + ch - 36, `${P(pv.powerBefore)} → ${P(pv.powerAfter)}`, 17, pv.powerAfter > pv.powerBefore + 0.5 ? '#66ee66' : '#cccccc'));
    });

    if (this.uiState === 'ITEM_FULL') {
      const card = offer.cards[this.sel], it = balance.items.find(x => x.id === card.target.itemId);
      const n = team.items.length, rows = wide ? 1 : n; // 窄屏：一行一个按钮，向上叠
      add(text(this, x0, by - 30 - (rows - 1) * 50, `物品栏已满：丢弃一件换 ${it.name}（1~3），Esc 返回改选别的卡`, 14, '#ffdd55', { wordWrap: { width: W - 40 } }).setOrigin(0, 1).setY(by - 8 - (rows - 1) * 50));
      team.items.forEach((id, k) => {
        const t2 = { ...team, items: team.items.map((x, j) => (j === k ? it.id : x)) };
        add(button(this, wide ? x0 + k * 230 : x0, wide ? by : by - (n - 1 - k) * 50, wide ? 220 : 280, 44, `[${k + 1}] 丢 ${balance.items.find(x => x.id === id)?.name}：战力→${P(computePower(t2, balance))}`, () => this.pick(this.sel, { discard: k }), { size: 13 }));
      });
      add(button(this, this.ox + W - 130, by, 110, 44, '[Esc] 返回', () => this.onCancel(), { size: 13 }));
      return;
    }
    if (this.uiState === 'CHOOSE_UNIT') {
      const rowsU = wide ? 1 : 2;
      add(text(this, x0, by - 8 - (rowsU - 1) * 50, '兵种令：选择全队兵种（1~4；选了就算用掉，换兵种操练清零）；Esc 返回改选别的卡', 14, '#ffdd55', { wordWrap: { width: W - 40 } }).setOrigin(0, 1));
      UNIT_ORDER_UNITS.forEach((u, k) => add(button(this, wide ? x0 + k * 170 : x0 + (k % 2) * 140, wide ? by : by - (1 - Math.floor(k / 2)) * 50, wide ? 160 : 130, 44, `[${k + 1}] ${UNIT_FULL_NAMES[u]}${team.unit === u ? '（现）' : ''}`, () => this.pick(this.sel, { unit: u }))));
      add(button(this, this.ox + W - 130, by, 110, 44, '[Esc] 返回', () => this.onCancel(), { size: 13 }));
      return;
    }
    const info = refreshInfo(st, balance, this.chapter);
    add(wide ? text(this, x0, by + 12, '点卡片或按 1~4 选一张（必须选）', 15, '#ffdd55') : text(this, x0, by + 2, '点卡片或按 1~4 选一张（必须选）', 13, '#ffdd55', { wordWrap: { width: W - 300 } }));
    this.refreshBtn = add(button(this, this.ox + W - (wide ? 260 : 240 + 20), by, 240, 44, `[F] 换一批（${info.free ? '免费' : `${info.cost} 点`}）`, () => this.doRefresh(), { enabled: info.ok, size: 15 }));
    if (this.message) add(wide ? text(this, x0 + 300, by + 12, this.message, 14, '#ff8888') : text(this, x0, by + 50, this.message, 13, '#ff8888', { wordWrap: { width: W - 40 } }));
  }
}
