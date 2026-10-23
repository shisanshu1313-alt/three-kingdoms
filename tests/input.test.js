import test from 'node:test';
import assert from 'node:assert/strict';
import { InputActions, actionsForKey, ACTIONS, DEFAULT_BINDINGS, KEY_CODES, withKeys } from '../src/platform/input.js';

const names = l => l.map(([a]) => a);

test('键位与改造前相同', () => {
  assert.deepEqual(names(actionsForKey('Enter', DEFAULT_BINDINGS, 13)), ['any', 'confirm']);
  assert.deepEqual(names(actionsForKey('Escape', DEFAULT_BINDINGS, 27)), ['any', 'cancel']);
  assert.deepEqual(names(actionsForKey(' ', DEFAULT_BINDINGS, 32)), ['any', 'primary']);
  for (const k of ['r', 'R']) assert.deepEqual(names(actionsForKey(k, DEFAULT_BINDINGS, 82)), ['any', 'release']);
  for (const k of ['y', 'Y']) assert.deepEqual(names(actionsForKey(k, DEFAULT_BINDINGS, 89)), ['any', 'yes']);
  for (const k of ['n', 'N']) assert.deepEqual(names(actionsForKey(k, DEFAULT_BINDINGS, 78)), ['any', 'no']);
  // G / F 键按键码（与 Phaser 'keydown-G' 一样不分大小写）
  for (const k of ['g', 'G']) assert.deepEqual(names(actionsForKey(k, DEFAULT_BINDINGS, KEY_CODES.G)), ['any', 'openGacha']);
  assert.deepEqual(names(actionsForKey('F5', DEFAULT_BINDINGS, 116)), ['any', 'save']);
  assert.deepEqual(names(actionsForKey('F9', DEFAULT_BINDINGS, 120)), ['any', 'load']);
  assert.deepEqual(names(actionsForKey('F1', DEFAULT_BINDINGS, 112)), ['any', 'debugVision']);
  assert.deepEqual(names(actionsForKey('F2', DEFAULT_BINDINGS, 113)), ['any', 'debugPoints']);
  const c = actionsForKey('3', DEFAULT_BINDINGS, 51);
  assert.deepEqual(c[1], [ACTIONS.CHOOSE, { n: 3, key: '3', repeat: false }]);
  assert.equal(actionsForKey('0')[1][1].n, 0);
  assert.deepEqual(names(actionsForKey('Shift', DEFAULT_BINDINGS, 16)), ['any']);
});

test('withKeys 改键不影响默认键位', () => {
  const b = withKeys(DEFAULT_BINDINGS, ACTIONS.OPEN_GACHA, [74]); // J（H 在 v0.6 是主城键）
  assert.deepEqual(names(actionsForKey('j', b, 74)), ['any', 'openGacha']);
  assert.deepEqual(names(actionsForKey('g', b, 71)), ['any']);
  assert.deepEqual(DEFAULT_BINDINGS.keys.openGacha, [KEY_CODES.G]);
});

test('分发：返回 true 的监听吞掉同一次按键后面的动作', () => {
  const a = new InputActions(), log = [];
  let consume = true;
  a.on('any', () => { log.push('any'); return consume; });
  a.on('cancel', () => log.push('cancel'));
  a.dispatch(actionsForKey('Escape'));
  assert.deepEqual(log, ['any']);
  consume = false; log.length = 0;
  a.dispatch(actionsForKey('Escape'));
  assert.deepEqual(log, ['any', 'cancel']);
  const off = a.on('cancel', () => log.push('cancel2')); off();
  log.length = 0; a.emit('cancel');
  assert.deepEqual(log, ['cancel']);
});

test('输入源可插拔：多个移动源相加并归一化（以后的触摸摇杆）', () => {
  const a = new InputActions();
  assert.deepEqual(a.moveVector(), { x: 0, y: 0 });
  const kb = { moveVector: () => ({ x: 1, y: 0 }) };
  let emitFn = null;
  const joystick = { v: { x: 0, y: 1 }, moveVector() { return this.v; }, attach(d) { emitFn = d; }, detached: false, detach() { this.detached = true; } };
  a.addSource(kb); a.addSource(joystick);
  const v = a.moveVector();
  assert.ok(Math.abs(Math.hypot(v.x, v.y) - 1) < 1e-9 && v.x > 0 && v.y > 0);
  joystick.v = { x: 0.3, y: 0 }; kb.moveVector = () => null;
  assert.deepEqual(a.moveVector(), { x: 0.3, y: 0 }); // 摇杆的半推保留力度
  const got = []; a.on('moveTo', p => got.push(p));
  emitFn([[ACTIONS.MOVE_TO, { x: 5, y: 6 }]]);
  assert.deepEqual(got, [{ x: 5, y: 6 }]);
  a.destroy();
  assert.ok(joystick.detached);
});

test('C / c → toggleStats（HUD 属性详情），不和其它动作冲突', () => {
  for (const k of ['c', 'C']) {
    const acts = actionsForKey(k, DEFAULT_BINDINGS, 67).map(a => a[0]);
    assert.deepEqual(acts, [ACTIONS.ANY, ACTIONS.TOGGLE_STATS]);
  }
});

test('v0.6 新动作：F 刷新、H 主城、E 替换副将（键位都在 DEFAULT_BINDINGS 里）', () => {
  assert.deepEqual(names(actionsForKey('f')), ['any', 'refresh']);
  assert.deepEqual(names(actionsForKey('H')), ['any', 'city']);
  assert.deepEqual(names(actionsForKey('e')), ['any', 'replace']);
});
