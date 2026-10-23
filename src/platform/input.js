/**
 * 输入动作层：场景只关心“动作”，不关心按的是哪个键 / 点的是鼠标还是手指。
 *
 * 动作（ACTIONS）：
 *   连续量：move（移动向量，moveVector() 读取）
 *   事件：  moveTo {x,y,pointer}（屏幕坐标，点地面寻路）、pointerMove {x,y}、zoom {dy}、tap {x,y}
 *           confirm、cancel、primary（抽卡/主按钮）、choose {n}（数字 0~9）、release（释放/放弃）、yes、no、
 *           openGacha、save、load、debugVision、debugPoints、any（任意键，用于跳过动画）、pause（P）、reorganize（B，城池整编）、toggleStats（C，属性详情）
 *
 * 输入源（source）：KeyboardSource、PointerSource（现在）；以后加 TouchJoystickSource / 小游戏触摸，只要实现
 *   { moveVector?(): {x,y}, attach(emit), detach() } 并 actions.addSource(src) 即可，场景代码不用改。
 *
 * 监听：actions.on(action, cb)；cb 返回 true 表示“已处理”，同一次按键后面的动作不再分发（例如 ROLLING 时任意键只用于跳过）。
 */

export const ACTIONS = Object.freeze({
  MOVE: 'move', MOVE_TO: 'moveTo', POINTER_MOVE: 'pointerMove', ZOOM: 'zoom', TAP: 'tap',
  CONFIRM: 'confirm', CANCEL: 'cancel', PRIMARY: 'primary', CHOOSE: 'choose', RELEASE: 'release', YES: 'yes', NO: 'no',
  OPEN_GACHA: 'openGacha', SAVE: 'save', LOAD: 'load', DEBUG_VISION: 'debugVision', DEBUG_POINTS: 'debugPoints', ANY: 'any',
  PAUSE: 'pause', REORGANIZE: 'reorganize', TOGGLE_STATS: 'toggleStats'
});

/** 键码（与 KeyboardEvent.keyCode 相同） */
export const KEY_CODES = Object.freeze({ F1: 112, F2: 113, F5: 116, F9: 120, G: 71 });

/**
 * 默认键位（与改造前完全相同）。
 * 字符串按 KeyboardEvent.key 匹配（区分大小写，所以字母写两遍）；数字按 keyCode 匹配（与 Phaser 'keydown-G' 相同，
 * 不受大小写 / 输入法影响）。移动键用 Phaser 键名（按键码）。
 */
export const DEFAULT_BINDINGS = Object.freeze({
  keys: {
    confirm: ['Enter'], cancel: ['Escape'], primary: [' '], release: ['r', 'R'], yes: ['y', 'Y'], no: ['n', 'N'],
    openGacha: [KEY_CODES.G], save: [KEY_CODES.F5], load: [KEY_CODES.F9], debugVision: [KEY_CODES.F1], debugPoints: [KEY_CODES.F2],
    pause: ['p', 'P'], reorganize: ['b', 'B'], // v0.5：暂停菜单（放弃本局）、城池整编
    toggleStats: ['c', 'C'] // HUD 属性详情（展开 / 收起）
  },
  move: { up: ['W', 'UP'], down: ['S', 'DOWN'], left: ['A', 'LEFT'], right: ['D', 'RIGHT'] }
});

/** 改一个动作的键位（返回新的 bindings，不改原对象） */
export function withKeys(bindings, action, keys) {
  return { ...bindings, keys: { ...bindings.keys, [action]: keys } };
}

/** 动作分发器（纯 JS） */
export class InputActions {
  constructor() { this.listeners = new Map(); this.sources = []; }
  on(action, cb) {
    if (!this.listeners.has(action)) this.listeners.set(action, []);
    this.listeners.get(action).push(cb);
    return () => this.off(action, cb);
  }
  off(action, cb) { const l = this.listeners.get(action); if (l) this.listeners.set(action, l.filter(f => f !== cb)); }
  /** 依次分发一组动作；某个监听返回 true 则停止 */
  dispatch(list) {
    for (const [action, payload] of list) {
      for (const cb of this.listeners.get(action) || []) if (cb(payload ?? {}) === true) return true;
    }
    return false;
  }
  emit(action, payload) { return this.dispatch([[action, payload]]); }
  addSource(src) { this.sources.push(src); src.attach?.(list => this.dispatch(list)); return src; }
  /** 所有输入源的移动向量相加后归一化（长度 ≤ 1） */
  moveVector() {
    let x = 0, y = 0;
    for (const s of this.sources) { const v = s.moveVector?.(); if (v) { x += v.x; y += v.y; } }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }
  destroy() { for (const s of this.sources) s.detach?.(); this.sources = []; this.listeners.clear(); }
}

/** 按键 → 动作列表（纯函数，便于测试）：先 any，再具体动作，数字键 → choose {n}；payload.repeat = 按住不放的自动重复 */
export function actionsForKey(key, bindings = DEFAULT_BINDINGS, keyCode = null, repeat = false) {
  const list = [[ACTIONS.ANY, { key, repeat }]];
  for (const [action, keys] of Object.entries(bindings.keys)) {
    if (keys.some(b => (typeof b === 'number' ? b === keyCode : b === key))) list.push([action, { key, repeat }]);
  }
  if (/^[0-9]$/.test(key)) list.push([ACTIONS.CHOOSE, { n: Number(key), key, repeat }]);
  return list;
}

/**
 * 键盘（Phaser 的键盘插件；只在本文件里接触键盘 API）
 * opts.move：是否读移动键（会阻止方向键滚动页面，只有大地图需要）；opts.capture：阻止浏览器默认行为的键名（如 'F5'）
 */
export class KeyboardSource {
  constructor(scene, bindings = DEFAULT_BINDINGS, { move = false, capture = [] } = {}) {
    this.scene = scene; this.bindings = bindings; this.readMove = move; this.capture = capture;
  }
  attach(dispatch) {
    const kb = this.scene.input.keyboard;
    if (!kb) return;
    if (this.capture.length) kb.addCapture(this.capture.join(','));
    if (this.readMove) {
      this.moveKeys = {};
      for (const [dir, names] of Object.entries(this.bindings.move)) this.moveKeys[dir] = names.map(n => kb.addKey(n, true));
    }
    // Phaser 3.90 KeyboardManager 每来一个 DOM 键盘事件就把本帧队列整个重新处理一遍（队列到 POST_STEP 才清空，
    // 去重只比较上一个事件）→ 一帧内 ≥ 3 个键盘事件时，前面的按键会被重复派发（例如 F1 切换两次、空格抽两次）。
    // 按原生事件对象去重：同一个 KeyboardEvent 只派发一次。
    const seen = new WeakSet();
    this.handler = e => {
      if (e && typeof e === 'object') { if (seen.has(e)) return; seen.add(e); }
      dispatch(actionsForKey(e.key, this.bindings, e.keyCode, !!e.repeat));
    };
    kb.on('keydown', this.handler);
  }
  moveVector() {
    if (!this.moveKeys) return null;
    const down = dir => this.moveKeys[dir].some(k => k.isDown);
    return { x: (down('right') ? 1 : 0) - (down('left') ? 1 : 0), y: (down('down') ? 1 : 0) - (down('up') ? 1 : 0) };
  }
  detach() { this.scene.input.keyboard?.off('keydown', this.handler); }
}

/** 鼠标 / 触屏点按（Phaser 指针）：左键按下 → tap + moveTo；移动 → pointerMove；滚轮 → zoom */
export class PointerSource {
  constructor(scene) { this.scene = scene; }
  attach(dispatch) {
    const inp = this.scene.input;
    this.down = p => { if (p.leftButtonDown()) dispatch([[ACTIONS.TAP, { x: p.x, y: p.y, pointer: p }], [ACTIONS.MOVE_TO, { x: p.x, y: p.y, pointer: p }]]); };
    this.move = p => dispatch([[ACTIONS.POINTER_MOVE, { x: p.x, y: p.y, pointer: p }]]);
    this.wheel = (_p, _o, _dx, dy) => dispatch([[ACTIONS.ZOOM, { dy }]]);
    inp.on('pointerdown', this.down); inp.on('pointermove', this.move); inp.on('wheel', this.wheel);
  }
  detach() { const inp = this.scene.input; inp.off('pointerdown', this.down); inp.off('pointermove', this.move); inp.off('wheel', this.wheel); }
}

/**
 * 场景用的快捷方式：键盘 + 指针两个输入源，场景关闭时自动销毁。
 * opts：bindings、keyboard、pointer、move（读移动键）、capture（阻止默认行为的键名）
 */
export function createSceneInput(scene, { bindings = DEFAULT_BINDINGS, keyboard = true, pointer = true, move = false, capture = [] } = {}) {
  const actions = new InputActions();
  if (keyboard) actions.addSource(new KeyboardSource(scene, bindings, { move, capture }));
  if (pointer) actions.addSource(new PointerSource(scene));
  scene.events.once('shutdown', () => actions.destroy());
  return actions;
}
