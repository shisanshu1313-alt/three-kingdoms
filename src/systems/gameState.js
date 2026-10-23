/** 玩家进度（积分、自由池、俘获记录、战报）。以后存档系统序列化它。 */
export function createGameState(balance) {
  return {
    points: 0,
    freePool: [...(balance?.initial_free_pool || [])], // 不在任何队伍中的名将 id（抽卡只从这里出）
    captured: [],        // 玩家俘获并已入队的武将（记录）
    pendingGenerals: [], // 满编时获得（俘获/抽卡）待“替换/释放”的武将队列 [{general, source:'capture'|'gacha', from}]
    battleLog: [],       // 最新在前 [{time, text}]
    battles: 0,
    gachaDraws: 0,
    gachaPending: null,  // 抽卡后未完成的选择 {next:'choose_general'|'item_full', ...}；见 gacha.js
    // v0.6
    cityStore: [],       // 主城存放的武将（roster_v06.storage，≤ storage_max）
    homeCity: null,      // 玩家主城 id（city_v06：同时只有 1 座）
    cities: null,        // 各城状态 { id: { owner, def, ... } }（systems/city.js createCities）
    gacha: { n: 0, offer: null, freeRefreshUsed: [0, 0, 0, 0], sinceEpic: 0 } // gacha_v06.save_fields
  };
}

export function pushLog(state, text, time = 0, keep = 30) {
  state.battleLog.unshift({ time, text });
  if (state.battleLog.length > keep) state.battleLog.length = keep;
}
