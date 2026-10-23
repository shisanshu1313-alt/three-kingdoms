import Phaser from 'phaser';
import { TILE_SIZE } from '../config.js';
import { createTilesetTexture } from '../render/tileset.js';
import { hasSave, archiveLegacySave, META_KEY } from '../systems/save.js';
import { loadMeta } from '../systems/meta.js';
import { getStorage } from '../platform/storage.js';

// 启动场景：生成占位纹理（以后在这里加载像素美术资源）
export default class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    createTilesetTexture(this, 'tiles', TILE_SIZE);
    const st = getStorage();
    // save_v05.keys.legacy：v0.4 存档（sanguo-save）改名归档、不读取，标题页提示一次
    const legacy = archiveLegacySave(st);
    // 总是先到标题页（QA-10 / 策划）：有进行中的一局 → 继续 / 放弃；有局外解锁 / 刚归档旧档 → 新一局选项 / 提示；
    // 都没有（第一次打开）→ 只有「开始」按钮 + 一行操作说明（TitleScene / ui/titleMode.js）
    this.scene.start('Title', { legacy });
  }
}
