import { createSceneInput, ACTIONS } from '../platform/input.js';
import Phaser from 'phaser';
import { balance } from '../data/index.js';
import { canPull, pull, oddsTable, freeByTier, resolveAttrChoice, resolveItemFull, resolveUnitOrder, UNIT_ORDER_UNITS, resultFromPending, describeItem, typeName, poolEntry, emptyTierFallback, pullCost } from '../systems/gacha.js';
import { mainGeneral } from '../systems/combat.js';
import { UNIT_FULL_NAMES } from '../systems/units.js';
import { button, text, generalLine, tierColor, TIER_COLORS, hex } from '../ui/widgets.js';

const UI = balance.gacha_ui ?? {};
const W = 860, H = 580;

/**
 * 抽卡界面（gacha_ui）。状态：IDLE / ROLLING / RESULT / CHOOSE_GENERAL / ITEM_FULL / ROSTER_FULL
 * 打开时大地图暂停（pause_world / pause_scope：游戏时钟冻结）。
 * 流程：抽 → ROLLING → RESULT（展示结果）→ 需要选择时确认后进入 CHOOSE_GENERAL / ITEM_FULL / ROSTER_FULL → 选完回 RESULT。
 * Esc（gacha_ui.esc_rule）：IDLE 关闭；ROLLING 跳过动画；RESULT 确认（回 IDLE 或进入选择）；三个选择状态忽略。
 * 键盘：Space 抽卡；Enter 在 RESULT 里确认/再抽；1~3 选择武将/物品；0 或 R 放弃新物品；ROLLING 时任意键/点击跳过。
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
    const act = createSceneInput(this);
    // ROLLING 时任意键（含 Esc）只用于跳过动画，返回 true 不再分发同一次按键的其它动作
    act.on(ACTIONS.ANY, () => { if (this.uiState === 'ROLLING') { this.finishRoll(); return true; } });
    act.on(ACTIONS.TAP, () => { if (this.uiState === 'ROLLING' && UI.roll_anim_skippable !== false) this.finishRoll(); });
    act.on(ACTIONS.CANCEL, () => this.onCancel());
    act.on(ACTIONS.CONFIRM, () => this.onPrimary());
    act.on(ACTIONS.PRIMARY, () => this.onPrimary());
    act.on(ACTIONS.CHOOSE, ({ n }) => this.onChoose(n));
    act.on(ACTIONS.RELEASE, () => { if (this.uiState === 'ITEM_FULL') this.itemFull(null); });
    this.events.on('resume', () => this.afterRoster());
    // 读档后有未完成的选择：直接回到对应选择状态（抽卡不回滚）
    const pending = resultFromPending(this.st, this.team, balance);
    if (pending) {
      this.result = pending;
      this.uiState = { choose_general: 'CHOOSE_GENERAL', choose_unit: 'CHOOSE_UNIT' }[pending.next] ?? 'ITEM_FULL';
    }
    this.render();
  }

  get st() { return this.world.state; }
  get team() { return this.world.player.team; }
  ctx() { return { inBattle: !!this.world.player.inBattle }; }

  /** gacha_ui.esc_rule（配置是中文说明，这里是它的逐条实现；配置里没有列出的状态按“忽略”处理） */
  escAction(state) {
    const ESC = { IDLE: 'close', ROLLING: 'skip', RESULT: 'confirm', CHOOSE_GENERAL: 'ignore', CHOOSE_UNIT: 'ignore', ITEM_FULL: 'ignore', ROSTER_FULL: 'ignore' };
    return UI.esc_rule && !(state in UI.esc_rule) ? 'ignore' : ESC[state] ?? 'ignore';
  }

  /** RESULT 确认：有待选择 → 进入对应选择状态；否则回 IDLE */
  confirmResult() {
    const r = this.result;
    if (r?.next === 'choose_general') this.uiState = 'CHOOSE_GENERAL';
    else if (r?.next === 'item_full') this.uiState = 'ITEM_FULL';
    else if (r?.next === 'choose_unit') this.uiState = 'CHOOSE_UNIT';
    else if (r?.next === 'roster_full') { this.uiState = 'ROSTER_FULL'; this.render(); return this.openRoster(); }
    else this.uiState = 'IDLE';
    this.render();
  }

  /** Esc（cancel）：按 esc_rule */
  onCancel() {
    const a = this.escAction(this.uiState);
    if (a === 'close') return this.close();
    if (a === 'confirm') return this.confirmResult();
  }

  /** Enter / 空格（confirm / primary）：有待选择先确认结果，否则再抽一次 */
  onPrimary() {
    const pendingChoice = this.uiState === 'RESULT' && this.result?.next;
    if (pendingChoice) return this.confirmResult();
    if (this.uiState === 'IDLE' || this.uiState === 'RESULT') return this.doPull();
  }

  /** 数字键（choose N）：选武将 1~3 / 物品栏 1~N，0 = 放弃新物品 */
  onChoose(n) {
    if (this.uiState === 'CHOOSE_GENERAL' && n >= 1 && n <= 3) {
      const i = n - 1; if (this.result.targets.includes(i)) this.chooseGeneral(i);
    }
    if (this.uiState === 'CHOOSE_UNIT') {
      if (n >= 1 && n <= UNIT_ORDER_UNITS.length) this.chooseUnit(UNIT_ORDER_UNITS[n - 1]);
      if (n === 0) this.chooseUnit(null);
    }
    if (this.uiState === 'ITEM_FULL') {
      if (n >= 1 && n <= this.team.items.length) this.itemFull(n - 1);
      if (n === 0) this.itemFull(null);
    }
  }

  close() {
    this.scene.stop();
    this.game.events.emit('modal-closed', 'Gacha');
  }

  doPull() {
    const chk = canPull(this.st, this.team, balance, this.ctx());
    if (!chk.ok) { this.message = chk.text; return this.render(); }
    // deduct_timing：立即扣点 + 次数+1；用存档里的 gacha 随机数流，结果产生后立即存档（抽卡原子化）
    this.result = pull(this.st, this.team, balance, this.world.rngs.gacha, this.ctx());
    this.world.player.refresh();
    this.world.trySaveNow('gacha');
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
  }

  finishRoll() {
    if (this.uiState !== 'ROLLING') return;
    this.rollTimer?.remove(); this.rollEnd?.remove();
    this.uiState = 'RESULT'; // 先展示结果；需要选择时由“确认”进入选择状态
    this.render();
  }

  chooseGeneral(i) {
    const up = resolveAttrChoice(this.st, this.team, i, balance, this.world.rngs.gacha);
    this.result.attr = up; this.result.text = up.text; this.result.next = null;
    this.world.player.refresh();
    this.world.trySaveNow('gacha');
    this.uiState = 'RESULT'; this.render();
  }

  /** 兵种令：换兵种（操练清零）或不改（返还点数） */
  chooseUnit(unit) {
    const r = resolveUnitOrder(this.st, this.team, unit, balance);
    this.result.text = r.changed ? `全队改为${UNIT_FULL_NAMES[r.unit]}（操练等级清零）` : `兵种不变，返还 ${r.refund} 点`;
    this.result.next = null;
    this.world.player.refresh(); this.world.field.refresh(this.world.player);
    this.world.trySaveNow('gacha');
    this.uiState = 'RESULT'; this.render();
  }

  itemFull(discardIndex) {
    const r = resolveItemFull(this.st, this.team, this.result.item, discardIndex, balance);
    this.result.text = r.text; this.result.next = null;
    this.world.player.refresh();
    this.world.trySaveNow('gacha');
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
      this.result.next = null;
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
      const e = poolEntry(balance, r.type);
      add(this.add.rectangle(x0, y + 2, 14, 14, TIER_COLORS[e.tier] ?? TIER_COLORS[r.type]).setOrigin(0));
      let extra = '';
      if (e.tier) {
        const n = freeByTier(st, balance, e.tier).length;
        extra = n ? `  自由池剩 ${n}` : `  已空，改出${typeName(poolEntry(balance, emptyTierFallback(balance)))}`;
      }
      add(text(this, x0 + 22, y, `${typeName(e)}  ${(r.p * 100).toFixed(0)}%${extra}`, 13, '#dddddd'));
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
      const head = r.general ? `${r.general.name}  ${r.general.tier} 级武将` : r.item ? `物品：${r.item.name}` : typeName(poolEntry(balance, r.type));
      add(text(this, x0 + 45, cy + 60, r.general ? r.general.tier : r.item ? '物' : r.type === 'unit_order' ? '令' : r.type === 'drill' ? '练' : `+${r.amount ?? ''}`, 28, '#000000').setOrigin(0.5));
      add(text(this, x0 + 110, cy, head + (r.fallback === 'empty_tier' ? `（${typeName(poolEntry(balance, r.rolledType))}已空，改出${typeName(poolEntry(balance, r.type))}）` : r.fallback === 'duplicate_general' ? '（武将已在队中）' : r.fallback === 'drill_max' ? '（操练已满 3 次，改出属性卡）' : ''), 17, hex(cardColor)));
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
    if (this.uiState === 'CHOOSE_UNIT') {
      add(text(this, x0, by - 30, `兵种令：选择全队兵种（数字键 1~4；0 = 不改，返还 ${balance.v05?.units?.unit_order_refund ?? 25} 点）`, 14, '#ffdd55'));
      UNIT_ORDER_UNITS.forEach((u, i) => add(button(this, x0 + i * 150, by, 140, 40, `[${i + 1}] ${UNIT_FULL_NAMES[u]}${team.unit === u ? '（现）' : ''}`, () => this.chooseUnit(u))));
      add(button(this, x0 + 610, by, 150, 40, '[0] 不改', () => this.chooseUnit(null), { color: 0x7f3b3b }));
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
    if (this.uiState === 'RESULT' && r?.next) {
      const what = { choose_general: '选择武将', choose_unit: '选择兵种', item_full: '处理物品栏', roster_full: '安排武将' }[r.next];
      add(text(this, x0, by - 26, `需要${what}（抽卡已扣点，不能取消）`, 14, '#ffdd55'));
      this.confirmBtn = add(button(this, x0, by, 240, 44, `确定 [Enter / Esc]`, () => this.confirmResult(), { color: 0x8e5a00, size: 16 }));
      return;
    }
    this.confirmBtn = null;
    this.pullBtn = add(button(this, x0, by, 240, 44, `抽一次（${cost} 点）[空格]`, () => this.doPull(), { enabled: chk.ok, color: 0x8e5a00, size: 16 }));
    add(button(this, this.ox + W - 180, by, 160, 44, `关闭 [Esc]`, () => this.close()));
    const msg = this.message || (!chk.ok ? chk.text : '');
    if (msg) add(text(this, x0 + 260, by + 12, msg, 14, '#ff8888'));
  }
}
