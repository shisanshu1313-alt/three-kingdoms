import Phaser from 'phaser';
import { TILE_SIZE } from '../config.js';
import { createTilesetTexture } from '../world/MapGenerator.js';
import { hasSave } from '../systems/save.js';

// 启动场景：生成占位纹理（以后在这里加载像素美术资源）
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    createTilesetTexture(this, 'tiles', TILE_SIZE);
    // 有存档 → 标题菜单（继续游戏 / 新游戏）；没有 → 直接开始
    if (hasSave()) this.scene.start('Title');
    else this.scene.start('World');
  }
}
