import Phaser from 'phaser';
import { balance } from '../data/index.js';
import { canPull, pull, oddsTable, freeByTier, applyAttrUpgrade, resolveItemFull, describeItem, TYPE_NAMES, pullCost } from '../systems/gacha.js';
import { mainGeneral } from '../systems/combat.js';
import { button, text, generalLine, tierColor, TIER_COLORS, hex } from '../ui/widgets.js';

const UI = balance.gacha_ui ?? {};
const W = 860, H = 580;

/**
 * 抽卡界面（gacha_ui）。状态：IDLE / ROLLING / RESULT / CHOOSE_GENERAL / ITEM_FULL / ROSTER_FULL
 * 打开时大地图暂停（pause_world）；Esc 关闭（选择中不可关闭，抽卡已扣点不能撤销）。
 * 键盘：Space/Enter 抽卡；1~3 选择武将/物品；0 或 R 放弃新物品；Esc 关闭；ROLLING 时任意键/点击跳过。
 */
export default class GachaScene extends Phaser.Scene {
  constructor() { super('Gacha'); }

  init() {
    this.world = this.scene.get('World');
    this.uiState = 'IDLE';
    this.result = null;
    this.message = '';
  }

  create() {
    const { width, height } = this.scale;
    this.ox = Math.round((width - W) / 2); this.oy = Math.round((height - H) / 2);
    this.add.rectangle(0, 0, width, height, 0x000000, 0.6).setOrigin(0).setInteractive(); // 遮罩，挡住点击
    this.add.rectangle(this.ox, this.oy, W, H, 0x1b1f2a, 0.97).setOrigin(0).setStrokeStyle(2, 0xf1c40f);
    text(this, this.ox + 20, this.oy + 14, '抽卡', 24, '#f1c40f');
    this.dyn = this.add.container(0, 0);
    this.input.keyboard.on('keydown', e => this.onKey(e));
    this.events.on('resume', () => this.afterRoster());
    this.render();
  }

  get st() { return this.world.state; }
  get team() { return this.world.player.team; }
  ctx() { return { inBattle: !!this.world.player.inBattle }; }

  onKey(e) {
    const k = e.key;
    if (this.uiState === 'ROLLING') { this.finishRoll(); return; }
    if (k === 'Escape' && (this.uiState === 'IDLE' || this.uiState === 'RESULT')) return this.close();
    if ((k === ' ' || k === 'Enter') && (this.uiState === 'IDLE' || this.uiState === 'RESULT')) return this.doPull();
    const n = Number(k);
    if (this.uiState === 'CHOOSE_GENERAL' && n >= 1 && n <= 3) {
      const i = n - 1; if (this.result.targets.includes(i)) this.chooseGeneral(i);
    }
    if (this.uiState === 'ITEM_FULL') {
      if (n >= 1 && n <= this.team.items.length) this.itemFull(n - 1);
      if (k === '0' || k === 'r' || k === 'R') this.itemFull(null);
    }
  }

  close() {
    this.scene.stop();
    this.game.events.emit('modal-closed', 'Gacha');
  }

  doPull() {
    const chk = canPull(this.st, this.team, balance, this.ctx());
    if (!chk.ok) { this.message = chk.text; return this.render(); }
    this.result = pull(this.st, this.team, balance, Math.random, this.ctx()); // deduct_timing：立即扣点 + 次数+1
    this.world.player.refresh();
    console.log(`[gacha] -${this.result.cost} ${this.result.type}${this.result.fallback ? `(${this.result.fallback})` : ''} ${this.result.text}`);
    this.message = '';
    this.startRoll();
  }

  /** roll_anim_s 秒的闪烁动画（【假设】样式），roll_anim_skippable 时任意键/点击跳过 */
  startRoll() {
    this.uiState = 'ROLLING';
    const dur = (UI.roll_anim_s ?? 1) * 1000;
    const colors = Object.values(TIER_COLORS);
    let i = 0;
    this.render();
    this.rollTimer = this.time.addEvent({ delay: 80, loop: true, callback: () => this.rollCard?.setFillStyle(colors[i++ % colors.length]) });
    this.rollEnd = this.time.delayedCall(dur, () => this.finishRoll());
    if (UI.roll_anim_skippable !== false) this.input.once('pointerdown', () => this.uiState === 'ROLLING' && this.finishRoll());
  }

  finishRoll() {
    if (this.uiState !== 'ROLLING') return;
    this.rollTimer?.remove(); this.rollEnd?.remove();
    const r = this.result;
    if (r.next === 'choose_general') this.uiState = 'CHOOSE_GENERAL';
    else if (r.next === 'item_full') this.uiState = 'ITEM_FULL';
    else if (r.next === 'roster_full') { this.uiState = 'ROSTER_FULL'; this.render(); return this.openRoster(); }
    else this.uiState = 'RESULT';
    this.render();
  }

  chooseGeneral(i) {
    const up = applyAttrUpgrade(this.team, i, this.result.amount, balance, Math.random);
    this.result.attr = up; this.result.text = up.text; this.result.next = null;
    this.world.player.refresh();
    this.uiState = 'RESULT'; this.render();
  }

  itemFull(discardIndex) {
    const r = resolveItemFull(this.st, this.team, this.result.item, discardIndex, balance);
    this.result.text = r.text; this.result.next = null;
    this.world.player.refresh();
    this.uiState = 'RESULT'; this.render();
  }

  /** ROSTER_FULL：在抽卡界面内立即弹出替换/释放窗口（roster.trigger） */
  openRoster() {
    this.scene.launch('Roster', { returnTo: 'Gacha' });
    this.scene.bringToTop('Roster');
    this.scene.pause();
  }

  afterRoster() {
    if (this.uiState === 'ROSTER_FULL') {
      const last = this.st.lastRosterText;
      if (last) this.result.text = `${this.result.text} → ${last}`;
      this.uiState = 'RESULT';
    }
    this.render();
  }

  render() {
    this.dyn.removeAll(true);
    const add = o => { this.dyn.add(o); return o; };
    const x0 = this.ox + 20, y0 = this.oy + 56, st = this.st, team = this.team;
    const cost = pullCost(st.gachaDraws, balance.gacha);
    const chk = canPull(st, team, balance, this.ctx());

    // 左：点数/价格/次数 + 概率表
    add(text(this, x0, y0, `当前点数：${st.points}`, 16, '#ffffff'));
    add(text(this, x0, y0 + 24, `下一抽价格：${cost} 点`, 16, st.points >= cost ? '#aaffaa' : '#ff8888'));
    add(text(this, x0, y0 + 48, `已抽次数：${st.gachaDraws}`, 14, '#cccccc'));
    add(text(this, x0, y0 + 80, '概率表', 15, '#f1c40f'));
    oddsTable(balance.gacha).forEach((r, i) => {
      const y = y0 + 104 + i * 24;
      add(this.add.rectangle(x0, y + 2, 14, 14, TIER_COLORS[r.type.replace('general_', '')] ?? TIER_COLORS[r.type]).setOrigin(0));
      let extra = '';
      if (r.type.startsWith('general_')) {
        const n = freeByTier(st, balance, r.type.slice(8)).length;
        extra = n ? `  自由池剩 ${n}` : '  已空，改出属性 +5';
      }
      add(text(this, x0 + 22, y, `${TYPE_NAMES[r.type]}  ${(r.p * 100).toFixed(0)}%${extra}`, 13, '#dddddd'));
    });

    // 右：队伍武将 + 物品栏
    const x1 = this.ox + 420;
    add(text(this, x1, y0, '队伍武将（★ 主将）', 15, '#f1c40f'));
    const main = mainGeneral(team, balance);
    team.generals.forEach((g, i) => {
      const y = y0 + 26 + i * 26;
      add(this.add.rectangle(x1, y + 2, 14, 14, tierColor(g)).setOrigin(0));
      add(text(this, x1 + 22, y, `${i + 1}. ${generalLine(g, { main: g === main })}`, 13));
    });
    add(text(this, x1, y0 + 112, `物品栏（${team.items.length}/${balance.team_rules.item_slots}）`, 15, '#f1c40f'));
    for (let i = 0; i < balance.team_rules.item_slots; i++) {
      const it = balance.items.find(x => x.id === team.items[i]);
      const y = y0 + 138 + i * 24;
      add(this.add.rectangle(x1, y + 2, 14, 14, it ? TIER_COLORS.item : 0x444444).setOrigin(0));
      add(text(this, x1 + 22, y, it ? `${i + 1}. ${it.name}：${describeItem(it)}` : `${i + 1}. （空）`, 13, it ? '#ffffff' : '#777777'));
    }
    const p = this.world.player;
    add(text(this, x1, y0 + 214, `兵 ${team.soldiers}/${p.cap}  战力 ${Math.round(p.power)}  速度 ${Math.round(p.speed)}`, 13, '#cccccc'));

    // 下：结果卡
    const cy = this.oy + 330;
    add(text(this, x0, cy - 26, '结果', 15, '#f1c40f'));
    const r = this.result;
    const cardColor = r ? (r.general ? tierColor(r.general) : r.item ? TIER_COLORS.item : r.refund && !r.attr ? TIER_COLORS.refund : TIER_COLORS[r.type]) : 0x333333;
    this.rollCard = add(this.add.rectangle(x0, cy, 90, 120, cardColor).setOrigin(0).setStrokeStyle(2, 0xffffff));
    if (this.uiState === 'ROLLING') {
      add(text(this, x0 + 110, cy + 40, '抽取中…（按任意键 / 点击跳过）', 16, '#ffffff'));
    } else if (r) {
      const head = r.general ? `${r.general.name}  ${r.general.tier} 级武将` : r.item ? `物品：${r.item.name}` : TYPE_NAMES[r.type];
      add(text(this, x0 + 45, cy + 60, r.general ? r.general.tier : r.item ? '物' : `+${r.amount ?? ''}`, 28, '#000000').setOrigin(0.5));
      add(text(this, x0 + 110, cy, head + (r.fallback === 'attr_big' ? `（${TYPE_NAMES[r.rolledType]}档已空，改出属性 +5）` : ''), 17, hex(cardColor)));
      if (r.general) add(text(this, x0 + 110, cy + 28, generalLine(r.general), 14));
      add(text(this, x0 + 110, cy + 54, r.text, 15, '#ffffff', { wordWrap: { width: 700 } }));
    } else {
      add(text(this, x0 + 110, cy + 40, '按 空格 / 点击“抽一次”', 15, '#aaaaaa'));
    }

    // 选择区
    const by = this.oy + H - 70;
    if (this.uiState === 'CHOOSE_GENERAL') {
      add(text(this, x0, by - 30, `属性 +${r.amount}：选择一名武将（数字键 1~3）`, 15, '#ffdd55'));
      r.targets.forEach((i, k) => add(button(this, x0 + k * 200, by, 190, 40, `[${i + 1}] ${team.generals[i].name}`, () => this.chooseGeneral(i))));
      return;
    }
    if (this.uiState === 'ITEM_FULL') {
      add(text(this, x0, by - 30, `物品栏已满：丢弃一件旧物品换 ${r.item.name}（1~3），或放弃（0 / R，返还 ${balance.gacha.duplicate_item_refund_points} 点）`, 14, '#ffdd55'));
      team.items.forEach((id, i) => add(button(this, x0 + i * 180, by, 170, 40, `[${i + 1}] 丢弃 ${balance.items.find(x => x.id === id)?.name}`, () => this.itemFull(i))));
      add(button(this, x0 + 560, by, 170, 40, '[0] 放弃新物品', () => this.itemFull(null), { color: 0x7f3b3b }));
      return;
    }
    if (this.uiState === 'ROSTER_FULL') { add(text(this, x0, by, '队伍已满：请在弹窗中选择替换或释放', 15, '#ffdd55')); return; }
    if (this.uiState === 'ROLLING') return;
    this.pullBtn = add(button(this, x0, by, 240, 44, `抽一次（${cost} 点）[空格]`, () => this.doPull(), { enabled: chk.ok, color: 0x8e5a00, size: 16 }));
    add(button(this, this.ox + W - 180, by, 160, 44, `关闭 [Esc]`, () => this.close()));
    const msg = this.message || (!chk.ok ? chk.text : '');
    if (msg) add(text(this, x0 + 260, by + 12, msg, 14, '#ff8888'));
  }
}
