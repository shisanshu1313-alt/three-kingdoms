/**
 * 队伍像素精灵：加载 atlas / overlays、建动画、按 formation 锚点摆装饰精灵。
 * 只影响画面；碰撞半径 / 战力仍走 melee / combat。
 */
import formation from '../data/partyFormation.json' with { type: 'json' };
import tints from '../data/factionTints.json' with { type: 'json' };
import { displaySlots, soldierTierList } from '../systems/displaySlots.js';

/** 现有 + 兵种造型 v1 图集；缺文件时 loaderror 可忽略，atlasFor 回退旧 key */
export const PARTY_ATLAS_KEYS = [
  'soldier_melee', 'soldier_bow', 'officer', 'named_base',
  'soldier_inf', 'soldier_spr', 'soldier_arc', 'soldier_cav', 'officer_cav', 'named_cav',
];
/** troop_silhouette_v1.atlas_matrix */
export const ATLAS_MATRIX = {
  inf: { soldier: 'soldier_inf', deputy: 'officer', leader: ['named_base', 'officer'] },
  spr: { soldier: 'soldier_spr', deputy: 'officer', leader: ['named_base', 'officer'] },
  arc: { soldier: 'soldier_arc', deputy: 'officer', leader: ['named_base', 'officer'] },
  cav: { soldier: 'soldier_cav', deputy: 'officer_cav', leader: ['named_cav', 'officer_cav'] },
};
const ATLAS_FALLBACK = {
  soldier: { arc: 'soldier_bow', default: 'soldier_melee' },
  deputy: 'officer',
  leader: 'named_base',
};
export const PARTY_OVERLAY_KEYS = ['ring_player', 'ring_thin', 'ring_enemy', 'crest_t1', 'banner_t2', 'crown_named', 'banner_faction_player', 'banner_faction_enemy'];
export const FX_ATLAS = { slash: 'fx_slash', dust: 'fx_dust' };
/** 方旗相对脚底上偏（美工 5202/cav：-12 仍压马背 → -16；不改骑位间距） */
export const BANNER_LIFT = -16;

/**
 * 选中环相对精灵 scale 的兵种布局（美工 5203）：
 * 骑兵主将体量更高，环若与本体同 scale 会竖切马肚；骑兵用更宽更扁椭圆并略下移贴蹄印。
 * 不改骑位间距 / 比例表 / 战斗。
 */
export const CAV_RING_SCALE_X = 1.3;   // × baseScale → 略宽过马身
export const CAV_RING_SCALE_Y = 0.7;   // × baseScale → 压扁，上弧不再切肚
export const CAV_RING_LIFT_Y = 10;      // Phaser y-down：环再下移贴蹄底（美工 5204：上弧仍擦踝 → +4）

/** @returns {{ scaleX: number, scaleY: number, liftY: number }} */
export function ringLayoutFor(unit, baseScale) {
  const s = Number(baseScale) || 1;
  if (String(unit || '') === 'cav') {
    return {
      scaleX: s * CAV_RING_SCALE_X,
      scaleY: s * CAV_RING_SCALE_Y,
      liftY: CAV_RING_LIFT_Y,
    };
  }
  return { scaleX: s, scaleY: s, liftY: 0 };
}

/** Container 同 y 绘制阶：ring（脚下）< 本体精灵 < 冠/旗等挂件 */
export function decorDrawTier(gameObject) {
  const k = String(gameObject?.getData?.('ovKey') || '');
  if (k.startsWith('ring_')) return 0;
  if (k) return 2;
  return 1; // sprite：无 ovKey
}

/** 先偏南（大 y）在上；同 y 再按 decorDrawTier */
export function compareDecorDrawOrder(a, b) {
  const dy = (a?.y ?? 0) - (b?.y ?? 0);
  if (dy !== 0) return dy;
  return decorDrawTier(a) - decorDrawTier(b);
}

/** ring 深度低于精灵；其它 overlay 略高于精灵 */
export function overlayDepthOffset(ovKey) {
  return String(ovKey || '').startsWith('ring_') ? -0.01 : 0.001;
}

/**
 * 表现层软跟排（不改 melee / display_slots / 碰撞）：
 * 士兵/副将屏幕槽位向目标 offset 指数逼近，弯道时后排拖出弧；主将贴死。
 * tau 秒：约 63% 追上目标所需时间。
 */
export const SOFT_FOLLOW_TAU = { leader: 0, deputy: 0.05, soldier: 0.10 };
/** 士兵越靠后（forward 越小）tau 越大，弯道弧更明显 */
export function softTauFor(role, forward = 0) {
  const base = SOFT_FOLLOW_TAU[role] ?? SOFT_FOLLOW_TAU.soldier;
  if (role !== 'soldier' || base <= 0) return base;
  // forward 约 -22…-6；后排多拖 ~40%
  const rear = Math.max(0, (-6 - forward) / 16);
  return base * (1 + 0.25 * rear);
}
/** 指数平滑一步；tau≤0 或 dt 异常 → 直接贴目标 */
export function softFollowStep(cur, target, dt, tau) {
  if (!cur || !(tau > 0) || !(dt > 0) || dt > 0.25) return { x: target.x, y: target.y };
  const a = 1 - Math.exp(-dt / tau);
  return { x: cur.x + (target.x - cur.x) * a, y: cur.y + (target.y - cur.y) * a };
}
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
  // 打击特效图集（slash / charge_dust）；缺文件时 Phaser 会报 loaderror，调用方可忽略
  scene.load.atlas(FX_ATLAS.slash, 'assets/sprites/fx/slash.png', 'assets/sprites/fx/slash.json');
  scene.load.atlas(FX_ATLAS.dust, 'assets/sprites/fx/charge_dust.png', 'assets/sprites/fx/charge_dust.json');
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

/** 候选图集：首选 → 旧图回退（缺图时用） */
export function atlasCandidates(unit, role = 'soldier') {
  const u = ATLAS_MATRIX[unit] ? unit : 'inf';
  const m = ATLAS_MATRIX[u];
  if (role === 'leader') {
    const pref = Array.isArray(m.leader) ? m.leader : [m.leader];
    return [...pref, 'named_base', 'officer'];
  }
  if (role === 'deputy') {
    return [m.deputy, 'officer'].filter((k, i, a) => a.indexOf(k) === i);
  }
  // soldier
  const legacy = u === 'arc' ? 'soldier_bow' : 'soldier_melee';
  return [m.soldier, legacy, 'soldier_melee'].filter((k, i, a) => a.indexOf(k) === i);
}

/**
 * 按兵种+角色选 atlas。exists(key) 有则取第一个存在的；无 exists 时返回首选（计划/单测）。
 */
export function atlasFor(unit, role = 'soldier', exists) {
  const cands = atlasCandidates(unit, role);
  if (typeof exists === 'function') {
    for (const k of cands) if (exists(k)) return k;
    // 全缺：角色级硬回退
    if (role === 'deputy') return ATLAS_FALLBACK.deputy;
    if (role === 'leader') return ATLAS_FALLBACK.leader;
    return (ATLAS_FALLBACK.soldier[unit] || ATLAS_FALLBACK.soldier.default);
  }
  return cands[0];
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

  // 主将（方旗：玩家 banner_faction_player / 敌方 banner_faction_enemy）
  const L = form.leader.local_offset_px;
  const leadOv = isPlayer
    ? [...(HERO_VIS.leader.overlays || ['ring_player', 'crown_named', 'banner_faction_player'])]
    : ['ring_enemy', 'crown_named', 'banner_faction_enemy'];
  const exists = typeof opts.exists === 'function' ? opts.exists : undefined;
  entries.push({
    role: 'leader',
    unit,
    atlas: atlasFor(unit, 'leader', exists),
    overlays: leadOv,
    forward: L.forward,
    right: L.right,
    scale: HERO_VIS.leader.scale ?? 1.4,
    tint: tint.tint,
  });

  // 副将（0..2）；1 名时只画 deputy_0，deputy_1 空位留间距
  const depN = slots.deputies;
  for (let i = 0; i < depN; i++) {
    const key = i === 0 ? 'deputy_0' : 'deputy_1';
    const o = form[key].local_offset_px;
    entries.push({
      role: 'deputy',
      unit,
      atlas: atlasFor(unit, 'deputy', exists),
      overlays: isPlayer ? ['ring_thin'] : ['ring_enemy'],
      forward: o.forward,
      right: o.right,
      scale: HERO_VIS.deputy.scale ?? 1.25,
      tint: tint.tint,
    });
  }

  // 士兵（按兵种剪影；缺图回退 melee/bow）
  const atlas = atlasFor(unit, 'soldier', exists);
  for (let i = 0; i < tiers.length; i++) {
    const slot = form.soldier_slots[Math.min(i, form.soldier_slots.length - 1)];
    const tier = tiers[i];
    const tv = TIER_VIS[`T${tier}`] || TIER_VIS.T0;
    const overlays = [...(tv.overlays || [])];
    // 敌方士兵环换成敌环
    const ov = overlays.map(k => (!isPlayer && k === 'ring_thin' ? 'ring_enemy' : k));
    entries.push({
      role: 'soldier',
      unit,
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
    this.nodes = []; // { sprite, overlays: Image[], soft?: {x,y} }
    this._key = '';
    this._dir = 's';
    this._moving = false;
    this._lastSoftMs = 0;
    scene.minimap?.ignore(this.root);
    ensurePartyAnims(scene);
    this.rebuild();
  }

  rebuild(opts = {}) {
    const exists = (k) => !!(this.scene?.textures?.exists?.(k));
    const plan = buildPartySpritePlan(this.model.team, { ...opts, exists });
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
        const im = this.scene.add.image(0, 0, ok).setOrigin(0.5, 1);
        if (String(ok).startsWith('ring_')) {
          const lay = ringLayoutFor(e.unit ?? this.model.team.unit, e.scale);
          im.setScale(lay.scaleX, lay.scaleY);
        } else {
          im.setScale(e.scale);
        }
        im.setData('ovKey', ok);
        ovs.push(im);
        this.root.add(im);
      }
      this.root.add(spr);
      this.nodes.push({ sprite: spr, overlays: ovs, entry: e, soft: null });
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
    // 帧 dt（表现层用）；逻辑仍 10Hz，这里只平滑槽位
    const nowMs = this.scene.time?.now ?? 0;
    const dt = this._lastSoftMs ? Math.min(0.05, Math.max(0, (nowMs - this._lastSoftMs) / 1000)) : 1 / 60;
    this._lastSoftMs = nowMs;

    for (const n of this.nodes) {
      const e = n.entry;
      const target = localOffset(h, e.forward, e.right);
      const tau = softTauFor(e.role, e.forward);
      const off = softFollowStep(n.soft, target, dt, tau);
      n.soft = off;
      n.sprite.setPosition(off.x, off.y);
      const akey = `${e.atlas}_${anim}_${dir}`;
      if (this.scene.anims.exists(akey) && n.sprite.anims.currentAnim?.key !== akey) {
        n.sprite.play(akey, true);
      } else if (!this.scene.anims.exists(akey)) {
        n.sprite.setFrame(`idle_${dir}_0`);
      }
      // 深度：偏南（大 y）的在上（用软位置）；ring_ 画在精灵脚下
      const spriteDepth = 10 + off.y * 0.01;
      n.sprite.setDepth(spriteDepth);
      for (const o of n.overlays) {
        const ovKey = String(o.getData('ovKey') || '');
        if (ovKey.startsWith('ring_')) {
          const lay = ringLayoutFor(e.unit ?? this.model.team.unit, e.scale);
          o.setPosition(off.x, off.y + lay.liftY);
          o.setScale(lay.scaleX, lay.scaleY);
        } else {
          const lift = ovKey.startsWith('banner_faction') ? BANNER_LIFT : 0;
          o.setPosition(off.x, off.y + lift);
        }
        o.setDepth(spriteDepth + overlayDepthOffset(ovKey));
      }
    }
    // container：先 y，同槽 ring < sprite < 其它挂件（避免选中环盖住马腿）
    this.root.list.sort(compareDecorDrawOrder);
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
