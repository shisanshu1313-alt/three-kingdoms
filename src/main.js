import Phaser from 'phaser';
import { balance } from './data/index.js';
import BootScene from './scenes/BootScene.js';
import WorldScene from './scenes/WorldScene.js';
import UIScene from './scenes/UIScene.js';
import TitleScene from './scenes/TitleScene.js';
import GachaScene from './scenes/GachaScene.js';
import RosterScene from './scenes/RosterScene.js';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#111111',
  pixelArt: true,
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  scene: [BootScene, TitleScene, WorldScene, UIScene, GachaScene, RosterScene]
});


// 便于调试 / 自动化测试
window.__game = game;
window.__balance = balance;
