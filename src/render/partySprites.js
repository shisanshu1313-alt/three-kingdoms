/**
 * 队伍像素精灵：加载 atlas / overlays、建动画、按 formation 锚点摆装饰精灵。
 * 只影响画面；碰撞半径 / 战力仍走 melee / combat。
 */
import formation from '../data/partyFormation.json' with { type: 'json' };
import tints from '../data/factionTints.json' with { type: 'json' };
import { displaySlots, soldierTierList } from '../systems/displaySlots.js';

export const PARTY_ATLAS_KEYS = ['soldier_melee', 'soldier_bow', 'officer', 'named_base'];
export const PARTY_OVERLAY_KEYS = ['ring_player', 'ring_thin', 'ring_enemy', 'crest_t1', 'banner_t2', 'crown_named'];
const BASE = 'assets/sprites/parties';
const DIRS = ['s', 'w', 'e', 'n'];
const TIER_VIS = formation.tier_visual;
const HERO_VIS = formation.hero_visual;

export function partyAssetsReady(scene) {
  return !!(scene?.textures?.exists?.('soldier_melee') && scene.textures.exists('officer'));
}

/** BootScene.preload：四底模 + 挂件 */
export function preloadPartyAssets(scene) {
  for (const k of PARTY_ATLAS_KEYS) {
    scene.load.atlas(k, `${BASE}/atlas/${k}.png`, `${BASE}/atlas/${k}.json`);
  }
  for (const k of PARTY_OVERLAY_KEYS) {
    scene.load.image(k, `${BASE}/overlays/${k}.png`);
  }
}

/** 每向 idle/walk/charge 动画（只建一次） */
export function ensurePartyAnims(scene) {
  if (scene.cache?.custom?.__partyAnims) return;
  if (scene.registry) {
    if (scene.registry.get('__partyAnims')) return;
    scene.registry.set('__partyAnims', true);
  }
  for (const atlas of PARTY_ATLAS_KEYS) {
    if (!scene.textures.exists(atlas)) continue;
    for (const dir of DIRS) {
      const idleKey = `${atlas}_idle_${dir}`;
      if (!scene.anims.exists(idleKey)) {
        scene.anims.create({
          key: idleKey,
          frames: [{ key: atlas, frame: `idle_${dir}_0` }],
          frameRate: 1,
          repeat: -1,
        });
      }
      for (const anim of ['walk', 'charge']) {
        const key = `${atlas}_${anim}_${dir}`;
        if (scene.anims.exists(key)) continue;
        scene.anims.create({
          key,
          frames: [0, 1, 2, 3].map(i => ({ key: atlas, frame: `${anim}_${dir}_${i}` })),
          frameRate: anim === 'walk' ? 8 : 10,
          repeat: -1,
        });
      }
    }
  }
}

/** 朝向角 → s/w/e/n（游戏 h：0=东，π/2=南） */
export function facingDir(h) {
  const a = ((Number(h) || 0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  if (a >= Math.PI * 7 / 4 || a < Math.PI / 4) return 'e';
  if (a < Math.PI * 3 / 4) return 's';
  if (a < Math.PI * 5 / 4) return 'w';
  return 'n';
}

/** formation local (forward,right) → 屏幕偏移 */
export function localOffset(h, forward, right) {
  const c = Math.cos(h), s = Math.sin(h);
  return { x: c * forward + (-s) * right, y: s * forward + c * right };
}

function tintFor(faction, isPlayer) {
  if (isPlayer || faction === 'player') return tints.player;
  return tints[faction] || tints.enemy_generic || tints.other;
}

function hexToInt(hex) {
  let h = String(hex || '#ffffff').replace(/^#|^0x/i, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return Number.isFinite(n) ? n : 0xffffff;
}

function soldierAtlas(unit) {
  return unit === 'arc' ? 'soldier_bow' : 'soldier_melee';
}

/**
 * 算出本帧要画的精灵描述（纯数据，可单测）。
 * deputies==0：士兵 forward 整体 +shift（贴主将，不留副将空位）。
 * deputies==1：副将占 deputy_0，deputy_1 留间距不画。
 * deputies==2：两名副将都画。
 */
export function buildPartySpritePlan(team, opts = {}) {
  const soldiers = opts.soldiers ?? team.soldiers ?? 0;
  const gens = team.generals ?? [];
  const slots = displaySlots(soldiers, gens);
  const form = formation.slots;
  const shiftFwd = slots.deputies === 0
    ? (form.deputy_0.local_offset_px.forward - form.soldier_slots[0].local_offset_px.forward)
    : 0;
  const tiers = soldierTierList(slots);
  const unit = team.unit || 'inf';
  const isPlayer = !!team.is_player;
  const tint = tintFor(team.faction, isPlayer);
  const entries = [];

  // 主将
  const L = form.leader.local_offset_px;
  entries.push({
    role: 'leader',
    atlas: isPlayer ? 'named_base' : 'named_base',
    overlays: isPlayer ? ['ring_player', 'crown_named'] : ['ring_enemy', 'crown_named'],
    forward: L.forward,
    right: L.right,
    scale: HERO_VIS.leader.scale ?? 1.15,
    tint: tint.tint,
  });

  // 副将（0..2）；1 名时只画 deputy_0，deputy_1 空位留间距
  const depN = slots.deputies;
  for (let i = 0; i < depN; i++) {
    const key = i === 0 ? 'deputy_0' : 'deputy_1';
    const o = form[key].local_offset_px;
    entries.push({
      role: 'deputy',
      atlas: 'officer',
      overlays: isPlayer ? ['ring_thin'] : ['ring_enemy'],
      forward: o.forward,
      right: o.right,
      scale: HERO_VIS.deputy.scale ?? 1.05,
      tint: tint.tint,
    });
  }

  // 士兵
  const atlas = soldierAtlas(unit);
  for (let i = 0; i < tiers.length; i++) {
    const slot = form.soldier_slots[Math.min(i, form.soldier_slots.length - 1)];
    const tier = tiers[i];
    const tv = TIER_VIS[`T${tier}`] || TIER_VIS.T0;
    const overlays = [...(tv.overlays || [])];
    // 敌方士兵环换成敌环
    const ov = overlays.map(k => (!isPlayer && k === 'ring_thin' ? 'ring_enemy' : k));
    entries.push({
      role: 'soldier',
      tier,
      atlas,
      overlays: ov,
      forward: slot.local_offset_px.forward + shiftFwd,
      right: slot.local_offset_px.right,
      scale: tv.scale ?? 1,
      tint: tint.tint,
    });
  }

  return { slots, entries, shiftFwd, tint };
}

/**
 * PartyView 用的装饰层：一组 sprite+overlay，每帧跟 body 走。
 */
export class PartyDecor {
  constructor(scene, model) {
    this.scene = scene;
    this.model = model;
    this.root = scene.add.container(model.x, model.y).setDepth(10);
    this.nodes = []; // { sprite, overlays: Image[] }
    this._key = '';
    this._dir = 's';
    this._moving = false;
    scene.minimap?.ignore(this.root);
    ensurePartyAnims(scene);
    this.rebuild();
  }

  rebuild(opts = {}) {
    const plan = buildPartySpritePlan(this.model.team, opts);
    const sol = opts.soldiers ?? this.model.team.soldiers ?? 0;
    const key = JSON.stringify({
      g: (this.model.team.generals || []).length,
      s: Math.floor(sol || 0),
      u: this.model.team.unit,
      f: this.model.team.faction,
      t: [plan.slots.t0, plan.slots.t1, plan.slots.t2, plan.slots.t3],
      d: plan.slots.deputies,
    });
    if (key === this._key && this.nodes.length) return plan;
    this._key = key;
    this.nodes = [];
    this.root.removeAll(true); // 一并销毁旧 sprite / overlay

    for (const e of plan.entries) {
      if (!this.scene.textures.exists(e.atlas)) continue;
      const spr = this.scene.add.sprite(0, 0, e.atlas, `idle_${this._dir}_0`);
      spr.setOrigin(0.5, 1).setScale(e.scale);
      const tintInt = hexToInt(e.tint);
      if (tintInt !== 0xffffff) spr.setTint(tintInt);
      const ovs = [];
      for (const ok of e.overlays || []) {
        if (!this.scene.textures.exists(ok)) continue;
        const im = this.scene.add.image(0, 0, ok).setOrigin(0.5, 1).setScale(e.scale);
        ovs.push(im);
        this.root.add(im);
      }
      this.root.add(spr);
      this.nodes.push({ sprite: spr, overlays: ovs, entry: e });
    }
    return plan;
  }

  /** 兵力 / 武将变化时强制重建 */
  invalidate() { this._key = ''; }

  sync(x, y, h = 0, moving = false, opts = {}) {
    this._syncOpts = opts;
    this.rebuild(opts);
    this.root.setPosition(x, y);
    const dir = facingDir(h);
    const anim = moving ? 'walk' : 'idle';
    if (dir !== this._dir || moving !== this._moving) {
      this._dir = dir;
      this._moving = moving;
    }
    for (const n of this.nodes) {
      const e = n.entry;
      const off = localOffset(h, e.forward, e.right);
      n.sprite.setPosition(off.x, off.y);
      const akey = `${e.atlas}_${anim}_${dir}`;
      if (this.scene.anims.exists(akey) && n.sprite.anims.currentAnim?.key !== akey) {
        n.sprite.play(akey, true);
      } else if (!this.scene.anims.exists(akey)) {
        n.sprite.setFrame(`idle_${dir}_0`);
      }
      // 深度：偏南（大 y）的在上
      n.sprite.setDepth(10 + off.y * 0.01);
      for (const o of n.overlays) {
        o.setPosition(off.x, off.y);
        o.setDepth(10 + off.y * 0.01 + 0.001);
      }
    }
    // container 内按 y 排序
    this.root.list.sort((a, b) => (a.y - b.y) || 0);
  }

  setAlpha(a) { this.root.setAlpha(a); }

  destroy() {
    for (const n of this.nodes) {
      n.sprite.destroy();
      for (const o of n.overlays) o.destroy();
    }
    this.nodes = [];
    this.root.destroy();
  }
}

export { formation, tints };
