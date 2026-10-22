/**
 * 队伍表现层（Phaser）：色块 + 标签 + 小地图标记，每帧从 PartyModel（systems/party.js）同步位置。
 * 逻辑都在模型里；这里只负责画。
 */
export default class PartyView {
  constructor(scene, model) {
    this.scene = scene;
    this.model = model;
    this.labelMode = null;
    this._rev = model.rev;
    const c = model.color;
    this.body = scene.add.rectangle(model.x, model.y, model.size, model.size, c)
      .setStrokeStyle(2, model.isPlayer ? 0xffffff : 0x000000).setDepth(10);
    this.label = scene.add.text(0, 0, '', {
      fontFamily: 'sans-serif', fontSize: '12px', color: '#ffffff', align: 'center',
      stroke: '#000000', strokeThickness: 3
    }).setOrigin(0.5, 1).setDepth(11);
    // 小地图标记（主相机不显示），否则 20px 色块缩到 1px 看不清
    this.minimapDot = scene.add.rectangle(model.x, model.y, 64, 64, c).setStrokeStyle(model.isPlayer ? 16 : 0, 0xffffff).setDepth(20);
    this.setLabelMode(model.isPlayer);
  }

  /** 位置同步；模型 refresh() 过（数值变化）就让标签重画 */
  sync() {
    const m = this.model;
    this.body.setPosition(m.x, m.y);
    this.minimapDot.setPosition(m.x, m.y);
    if (this._rev !== m.rev) { this._rev = m.rev; this.labelMode = null; this.setLabelMode(this._wantFull ?? m.isPlayer); }
  }

  /** 标签：简略（名字+兵）/ 完整（加武将、战力） */
  setLabelMode(full) {
    this._wantFull = full;
    const mode = full ? 'full' : 'compact';
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    const m = this.model, t = m.team;
    if (full) {
      const gens = t.generals.map(g => g.name).join('·');
      this.label.setText(`${t.name}\n${gens}\n兵${t.soldiers}/${m.cap} 战${Math.round(m.power)}`);
    } else {
      this.label.setText(`${t.name} ${t.soldiers}`);
    }
  }

  /** 战斗中标签：名字 + 正在播放的兵数 */
  setBattleLabel(shown) {
    const txt = `⚔ ${this.model.team.name} 兵${shown}`;
    if (this.label.text !== txt) this.label.setText(txt);
    this.labelMode = 'battle';
  }

  destroy() { this.body.destroy(); this.label.destroy(); this.minimapDot.destroy(); }
}
