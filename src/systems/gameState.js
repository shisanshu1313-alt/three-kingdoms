/** 玩家进度（积分、自由池、俘获记录、战报）。以后存档系统序列化它。 */
export function createGameState(balance) {
  return {
    points: 0,
    freePool: [...(balance?.initial_free_pool || [])], // 不在任何队伍中的名将 id（抽卡只从这里出）
    captured: [],        // 玩家俘获并已入队的武将（记录）
    pendingGenerals: [], // 满编时获得（俘获/抽卡）待“替换/释放”的武将队列 [{general, source:'capture'|'gacha', from}]
    battleLog: [],       // 最新在前 [{time, text}]
    battles: 0,
    gachaDraws: 0
  };
}

export function pushLog(state, text, time = 0, keep = 30) {
  state.battleLog.unshift({ time, text });
  if (state.battleLog.length > keep) state.battleLog.length = keep;
}
