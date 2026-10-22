import Phaser from 'phaser';

// 全局事件总线：各系统通过它解耦通信。
export const EventBus = new Phaser.Events.EventEmitter();
export const EVENTS = {
  PARTY_COLLISION: 'party-collision', // { a, b, time }  两支队伍接触（去抖）
  PARTY_SIGHTED: 'party-sighted',     // { a, b, dist }  一对队伍进入视野（vision_px）
  AI_STATE: 'ai-state',               // { party, from, to, targetId }  AI 进入追击/逃跑
  BATTLE_START: 'battle-start',       // { battle }
  BATTLE_END: 'battle-end',           // { battle, outcome }  outcome 见 battle.applyBattleResult
  PARTY_SPAWNED: 'party-spawned',     // { party }
  PARTY_REMOVED: 'party-removed'      // { party }
};
