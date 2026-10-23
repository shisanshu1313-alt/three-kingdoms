import { createSceneInput, ACTIONS } from '../platform/input.js';
import Phaser from 'phaser';
import { balance, run as runCfg } from '../data/index.js';
import { MAP_SEED } from '../config.js';
import { loadSave, clearSave, META_KEY } from '../systems/save.js';
import { loadMeta, saveMeta, startOptions, applyRunResult } from '../systems/meta.js';
import { runSummary } from '../systems/run.js';
import { UNIT_FULL_NAMES } from '../systems/units.js';
import { getStorage } from '../platform/storage.js';
import { button, text } from '../ui/widgets.js';
import { titleMode, firstRunLayout, FIRST_RUN_CONTROLS } from '../ui/titleMode.js';

const fmtS = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * 标题（v0.5 单槽 run 存档）：
 *   有进行中的一局 → 继续 [Enter/1]；放弃并开新局 [N/2]（需确认；放弃 = 本局失败，计入局外数据）
 *   没有 → 新一局面板：局外解锁的开局选项（1 兵种 / 2 随从 / 3 物品 / 4 群雄模式），Enter 开始
 *   存档损坏 / 不兼容：显示原因，只能开新局；旧版存档已归档时提示一次。绝不崩溃。
 */
export default class TitleScene extends Phaser.Scene {
  constructor() { super('Title'); }

  init(data) { this.forcedError = data?.error ?? null; this.legacy = !!data?.legacy; this.confirming = false; }

  create() {
    const st = getStorage();
    this.result = this.forcedError ? { ok: false, code: 'corrupt', message: this.forcedError } : loadSave({ balance, mapSeed: MAP_SEED }, st);
    if (!this.result.ok && this.result.code === 'empty') this.result = null; // 没有进行中的一局
    this.meta = loadMeta(st, META_KEY);
    this.opts = startOptions(this.meta, runCfg);
    this.sel = { unit: 0, general: -1, item: 0, hard: false };
    this.root = this.add.container(0, 0);
    const act = createSceneInput(this, { pointer: false });
    act.on(ACTIONS.CONFIRM, () => this.onAction('confirm'));
    act.on(ACTIONS.CANCEL, () => this.onAction('cancel'));
    act.on(ACTIONS.YES, () => this.onAction('yes'));
    act.on(ACTIONS.NO, () => this.onAction('no'));
    act.on(ACTIONS.CHOOSE, ({ n }) => this.onAction(`n${n}`));
    this.render();
    this.scale.on('resize', this.render, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.render, this));
  }

  get hasRun() { return !!this.result?.ok; }

  onAction(a) {
    if (this.confirming) {
      if (a === 'yes' || a === 'confirm') { this.abandonSaved(); this.confirming = false; this.render(); }
      if (a === 'no' || a === 'cancel') { this.confirming = false; this.render(); }
      return;
    }
    if (this.hasRun) {
      if (a === 'confirm' || a === 'n1') this.continueGame();
      if (a === 'no' || a === 'n2') { this.confirming = true; this.render(); }
      return;
    }
    // 新一局面板
    const o = this.opts, s = this.sel;
    if (a === 'confirm') return this.newGame();
    if (a === 'n1' && o.units.length > 1) s.unit = (s.unit + 1) % o.units.length;
    else if (a === 'n2' && o.generals.length) s.general = s.general + 1 >= o.generals.length ? -1 : s.general + 1;
    else if (a === 'n3' && o.items.length > 1) s.item = (s.item + 1) % o.items.length;
    else if (a === 'n4' && o.hard) s.hard = !s.hard;
    else return;
    this.render();
  }

  continueGame() { this.scene.start('World', { save: this.result.save, warnings: this.result.warnings }); }

  /** 放弃存档里的一局：先删档，再按失败写局外数据（按 runId 去重） */
  abandonSaved() {
    const st = getStorage(), save = this.result?.ok ? this.result.save : null;
    clearSave(st);
    if (save?.run) {
      const r = structuredClone(save.run); r.over = { result: 'defeat', reason: 'abandon', atS: save.gameTimeMs / 1000 };
      const { meta } = applyRunResult(this.meta, runSummary(r, save.gameTimeMs / 1000, runCfg), runCfg);
      saveMeta(st, META_KEY, meta); this.meta = meta; this.opts = startOptions(meta, runCfg);
    }
    this.result = null;
  }

  newRunOptions() {
    const o = this.opts, s = this.sel;
    return { unit: o.units[s.unit], general: s.general >= 0 ? o.generals[s.general] : null, item: o.items[s.item], hard: s.hard };
  }

  newGame() {
    if (this.result && !this.result.ok) clearSave(getStorage()); // 损坏 / 不兼容的存档
    this.scene.start('World', { newRun: this.newRunOptions() });
  }

  /** 第一次打开：标题 + 「开始」按钮 + 一行操作说明（Enter / 点按按钮都开始；竖屏 ~380 宽放得下） */
  renderFirst(add, w, h, cx) {
    const L = firstRunLayout(w, h);
    this.btnContinue = null;
    add(text(this, cx, h * 0.22, '三国 · 群雄逐鹿', L.titleSize, '#f1c40f').setOrigin(0.5));
    add(text(this, cx, h * 0.22 + 44, `20 分钟一局 · 讨平四路名将 · 数值 v${balance._meta?.version ?? '?'}`, 14, '#999999', { wordWrap: { width: L.wrap, useAdvancedWrap: true }, align: 'center', padding: { x: 8, y: 2 } }).setOrigin(0.5, 0));
    this.btnNew = add(button(this, cx - L.btnW / 2, L.by - L.btnH / 2, L.btnW, L.btnH, '开始 [Enter]', () => this.newGame(), { color: 0x8e5a00, size: 20 }));
    this.controlsText = add(text(this, cx, L.by + L.btnH / 2 + 24, FIRST_RUN_CONTROLS, 14, '#cfd8e3', { wordWrap: { width: L.wrap, useAdvancedWrap: true }, align: 'center', padding: { x: 8, y: 2 } }).setOrigin(0.5, 0));
  }

  render() {
    this.root.removeAll(true);
    const add = o => { this.root.add(o); return o; };
    const { width: w, height: h } = this.scale, cx = w / 2;
    add(this.add.rectangle(0, 0, w, h, 0x10131a).setOrigin(0));
    this.mode = this.confirming ? 'confirm' : titleMode({ result: this.result, legacy: this.legacy, unlocked: this.meta.unlocked });
    if (this.mode === 'first') return this.renderFirst(add, w, h, cx);
    add(text(this, cx, h * 0.16, '三国 · 群雄逐鹿', 40, '#f1c40f').setOrigin(0.5));
    add(text(this, cx, h * 0.16 + 44, `20 分钟一局 · 讨平四路名将 · 数值 v${balance._meta?.version ?? '?'}`, 14, '#999999').setOrigin(0.5));
    const m = this.meta;
    add(text(this, cx, h * 0.16 + 66, `累计名望 ${m.fameTotal} · 已玩 ${m.runs} 局 · 通关 ${m.clears} · 最久存活 ${fmtS(m.bestSurvivedS)}`, 13, '#8fa3b8').setOrigin(0.5));
    if (this.legacy) add(text(this, cx, h * 0.16 + 88, '旧版存档不兼容，已归档', 14, '#ffdd55').setOrigin(0.5));
    const r = this.result, by = h * 0.46;
    if (this.confirming) {
      add(this.add.rectangle(cx - 230, by - 30, 460, 150, 0x2a1f1f).setOrigin(0).setStrokeStyle(2, 0xe74c3c));
      add(text(this, cx, by, '放弃当前这一局？', 20, '#ffffff').setOrigin(0.5));
      add(text(this, cx, by + 28, '存档将被删除，本局按失败结算（名望照常计入）。', 14, '#ffaaaa').setOrigin(0.5));
      add(button(this, cx - 200, by + 60, 180, 40, '放弃 [Y]', () => this.onAction('yes'), { color: 0x7f3b3b }));
      add(button(this, cx + 20, by + 60, 180, 40, '取消 [N]', () => this.onAction('no')));
      return;
    }
    if (r?.ok) {
      const s = r.save, p = s.player.team, run = s.run, ch = runCfg.chapters[run.chapter];
      add(text(this, cx, by - 44, `进行中的一局 · ${ch.name} · ${fmtS(s.gameTimeMs / 1000)} / ${runCfg.duration_min}:00${run.hard ? ' · 群雄模式' : ''}`, 15, '#ffffff').setOrigin(0.5));
      add(text(this, cx, by - 22, `主角 HP ${Math.round(run.heroHp)} · 兵 ${p.soldiers} · ${UNIT_FULL_NAMES[p.unit] ?? ''} · 讨平名将 ${run.namedDefeated.length}/${runCfg.run_goal.named.length} · 点数 ${s.state.points}`, 14, '#cccccc').setOrigin(0.5));
      if (s.combat && Object.keys(s.combat.state?.pairs ?? {}).length) add(text(this, cx, by - 2, '（存档时正在交战：继续后暂停，倒计时 3 秒继续战斗）', 13, '#ffaa66').setOrigin(0.5));
      for (const [i, wmsg] of (r.warnings || []).entries()) add(text(this, cx, by + 16 + i * 18, wmsg, 13, '#ffdd55').setOrigin(0.5));
      this.btnContinue = add(button(this, cx - 120, by + 50, 240, 46, '继续 [Enter]', () => this.continueGame(), { color: 0x8e5a00, size: 18 }));
      this.btnNew = add(button(this, cx - 120, by + 110, 240, 46, '放弃本局 [N]', () => { this.confirming = true; this.render(); }, { size: 18 }));
      return;
    }
    this.btnContinue = null;
    let y = by - 50;
    if (r && !r.ok) {
      add(text(this, cx, y, `无法读取存档：${r.message}`, 15, '#ff8888', { wordWrap: { width: Math.min(700, w - 40) }, align: 'center' }).setOrigin(0.5));
      y += 30;
    }
    // 新一局选项（只有横向解锁，没有永久数值）
    const o = this.opts, s = this.sel, nm = id => balance.items.find(i => i.id === id)?.name ?? id;
    const gen = id => balance.generals.find(g => g.id === id)?.name ?? id;
    const rows = [
      [`[1] 开局兵种：${UNIT_FULL_NAMES[o.units[s.unit]]}`, o.units.length > 1 ? `（已解锁 ${o.units.length}/4）` : '（第 2 章起解锁枪兵…）'],
      [`[2] 开局随从：${s.general >= 0 ? gen(o.generals[s.general]) : '无'}`, o.generals.length ? '' : '（累计名望 300 解锁廖化）'],
      [`[3] 开局物品：${nm(o.items[s.item])}`, o.items.length > 1 ? '' : '（累计名望 600 解锁更多）'],
      [`[4] 群雄模式：${s.hard ? '开' : '关'}`, o.hard ? '（刷新战力 +0.1，克制倍率 +0.05）' : '（首次通关解锁）']
    ];
    for (const [a, b] of rows) {
      add(text(this, cx - 200, y, a, 16, '#ffffff'));
      add(text(this, cx + 20, y + 2, b, 13, '#8fa3b8'));
      y += 28;
    }
    this.btnNew = add(button(this, cx - 120, y + 16, 240, 46, '开始新的一局 [Enter]', () => this.newGame(), { color: 0x8e5a00, size: 18 }));
    if (m.unlocked.length) add(text(this, cx, y + 80, `已解锁：${m.unlocked.map(id => runCfg.meta.unlocks.find(u => u.id === id)?.name ?? id).join('、')}`, 13, '#8fa3b8').setOrigin(0.5));
  }
}
