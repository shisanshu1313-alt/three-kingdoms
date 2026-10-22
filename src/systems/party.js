import { PARTY_SIZE, CLICK_ARRIVE_DIST } from '../config.js';
import { computePower, soldierCap, teamSpeed } from './combat.js';

/** '#rrggbb' / '#rgb' → 0xrrggbb（与 Phaser HexStringToColor 结果相同） */
export function hexToInt(hex) {
  let h = String(hex).replace(/^#|^0x/i, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 队伍逻辑模型（纯 JS，不依赖 Phaser / DOM）：包着纯数据 team 对象（结构 = balance.team_example），
 * 位置就是 team.position。AI / 战斗 / 碰撞 / 存档都只读写它；画面由 entities/PartyView.js 每帧同步。
 *
 * 移动（v0.5）：move / stepToward / followPath 只设置 intent（期望朝向与速度），真正的移动在 melee.step 里。
 * _fits(x,y,world) 的 world 需要 isPassable(x,y)（见 systems/world.js 的 WorldModel）。
 */
export default class PartyModel {
  constructor(team, balance, color = '#ffffff') {
    this.team = team;
    this.balance = balance;
    this.size = PARTY_SIZE;
    this.color = hexToInt(color);
    this.path = null;          // [{x,y}] 世界坐标路点
    this.inBattle = null;      // 当前战斗对象
    this.invincibleUntil = 0;  // 玩家战败后无敌截止（游戏时间 ms）
    this.stuckTime = 0;
    this.rev = 0;              // refresh() 次数：表现层据此知道标签要重画
    this.refresh();
  }

  get id() { return this.team.id; }
  get name() { return this.team.name; }
  get faction() { return this.team.faction; }
  get isPlayer() { return this.team.is_player; }
  get soldiers() { return this.team.soldiers; }
  get x() { return this.team.position.x; }
  get y() { return this.team.position.y; }
  isInvincible(now) { return this.invincibleUntil > now; }

  /** 实际移动速度（未含地形）：配置速度 × 战败逃跑加速（无敌期间） */
  moveSpeed(now) {
    const esc = this.isInvincible(now) ? this.balance.battle.player_defeat.escape_speed_mult : 1;
    return this.speed * esc;
  }

  /** 队伍数值变化后调用：重算战力/上限/速度 */
  refresh() {
    this.power = computePower(this.team, this.balance);
    this.cap = soldierCap(this.team, this.balance);
    this.speed = teamSpeed(this.team, this.balance);
    this.rev++;
  }

  /** 位置。v0.5：战斗体（FieldBattle）是位置的权威；直接设位置（读档、刷新、调试）时同步过去 */
  setPosition(x, y) {
    this.team.position.x = x; this.team.position.y = y;
    const b = this.combat?.body(this.id);
    if (b && (b.x !== x || b.y !== y)) { b.x = x; b.y = y; }
  }

  getBounds() {
    const h = this.size / 2;
    return { left: this.x - h, right: this.x + h, top: this.y - h, bottom: this.y + h };
  }

  /**
   * v0.5：队伍不再直接改位置，只给出“期望朝向 + 期望速度”（this.intent），由 melee.step 按加速度 / 转向 / 接触减速移动。
   * 按方向 (dx,dy)（长度≤1）全速走。
   */
  move(dx, dy) {
    if (!dx && !dy) return false;
    this.intent = { h: Math.atan2(dy, dx), v: 1e6 * Math.min(1, Math.hypot(dx, dy)) };
    return false;
  }

  /** 朝某点走（最后一段按距离减速，避免冲过头）；返回 'arrived' | 'moving' | 'stuck'（两次调用之间几乎没动累计 0.4 s） */
  stepToward(tx, ty, dt) {
    const ddx = tx - this.x, ddy = ty - this.y;
    const d = Math.hypot(ddx, ddy);
    if (d <= CLICK_ARRIVE_DIST) { this._last = null; return 'arrived'; }
    this.intent = { h: Math.atan2(ddy, ddx), v: Math.max(20, d / Math.max(dt, 1e-3) * 0.5) };
    const last = this._last;
    this._last = { x: this.x, y: this.y };
    if (last && Math.abs(this.x - last.x) < 0.01 && Math.abs(this.y - last.y) < 0.01) {
      this.stuckTime += dt;
      return this.stuckTime > 0.4 ? 'stuck' : 'moving';
    }
    this.stuckTime = 0;
    return 'moving';
  }

  setPath(points) { this.path = points && points.length ? points : null; this.stuckTime = 0; this._last = null; }
  clearPath() { this.path = null; }

  /** 沿路径移动；返回 'none' | 'moving' | 'arrived' | 'stuck' */
  followPath(dt, world) {
    if (!this.path) return 'none';
    const wp = this.path[0];
    const r = this.stepToward(wp.x, wp.y, dt);
    if (r === 'arrived') {
      this.path.shift();
      if (!this.path.length) { this.path = null; return 'arrived'; }
      return 'moving';
    }
    if (r === 'stuck') { this.path = null; return 'stuck'; }
    return 'moving';
  }

  /** 色块放在 (x,y) 时四角是否都可通行 */
  _fits(x, y, world) {
    const h = this.size / 2 - 1;
    return world.isPassable(x - h, y - h) && world.isPassable(x + h, y - h) &&
           world.isPassable(x - h, y + h) && world.isPassable(x + h, y + h);
  }
}
