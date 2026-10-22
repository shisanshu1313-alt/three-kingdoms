import Phaser from 'phaser';
import { TILE_SIZE } from '../config.js';
import { createTilesetTexture } from '../world/MapGenerator.js';

// 启动场景：生成占位纹理（以后在这里加载像素美术资源）
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    createTilesetTexture(this, 'tiles', TILE_SIZE);
    this.scene.start('World');
  }
}
