import Phaser from 'phaser';
import { balance } from './data/index.js';
import BootScene from './scenes/BootScene.js';
import WorldScene from './scenes/WorldScene.js';
import UIScene from './scenes/UIScene.js';
import TitleScene from './scenes/TitleScene.js';
import GachaScene from './scenes/GachaScene.js';
import RosterScene from './scenes/RosterScene.js';
import { scaleConfig } from './platform/screen.js';
import { DEBUG_HOOKS, installDebugHooks } from './debug.js';

// 屏幕尺寸走平台接口（platform/screen.js）：网页铺满窗口并跟随缩放，小游戏用屏幕尺寸
const sc = scaleConfig();
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#111111',
  pixelArt: true,
  scale: { mode: Phaser.Scale[sc.mode], width: sc.width, height: sc.height },
  scene: [BootScene, TitleScene, WorldScene, UIScene, GachaScene, RosterScene]
});

// 调试 / 自动化测试钩子：只在开发模式和冒烟测试构建里有（正式构建整段移除）
if (DEBUG_HOOKS) installDebugHooks(game, balance);
