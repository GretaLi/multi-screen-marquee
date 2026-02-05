/**
 * Multi-Screen Marquee Sync Server
 *
 * 功能：
 * - WebSocket Server 作為同步中樞
 * - 靜態頁面服務 (/controller, /player)
 * - 健康檢查端點 (/health)
 *
 * 事件格式：
 * - hello: client 連線註冊 {type:"hello", role:"player"|"controller", playerId?, actualWidth?}
 * - init: server 回應 {type:"init", startAt, now, config?}
 * - tick: server 定期廣播 {type:"tick", now}
 * - config: server 對 player 下發配置 {type:"config", screenCount, screenIndex, offsetPx}
 * - players: server 對 controller 廣播 player 列表 {type:"players", list:[...]}
 * - setConfig: controller 設定 player {type:"setConfig", playerId, screenCount, screenIndex}
 * - quickApply: controller 一鍵套用（自動計算各螢幕 offset）{type:"quickApply"}
 * - reportWidth: player 回報實際螢幕寬度 {type:"reportWidth", actualWidth}
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// ============ 配置 ============
const PORT = process.env.PORT || 3000;
const TICK_INTERVAL_MS = 5000; // 每 5 秒校時
const DEFAULT_SPEED_PX_SEC = 120; // 預設跑馬燈速度

// ============ 狀態 ============
const startAt = Date.now(); // 固定起始時間
const players = new Map(); // playerId -> { ws, config, connectedAt }
const controllers = new Set(); // controller ws set

// ============ Express 設定 ============
const app = express();
const server = http.createServer(app);

// 靜態檔案
app.use(express.static(path.join(__dirname, 'public')));

// 路由
app.get('/controller', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'controller.html'));
});

app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Date.now() - startAt,
    startAt,
    playersOnline: players.size,
    controllersOnline: controllers.size
  });
});

// ============ WebSocket Server ============
const wss = new WebSocket.Server({
  server,
  maxPayload: 50 * 1024 * 1024 // 50MB - 支援大型 Base64 圖片
});

// 廣播給所有 controllers
function broadcastToControllers(data) {
  const msg = JSON.stringify(data);
  controllers.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// 廣播給所有 players
function broadcastToPlayers(data) {
  const msg = JSON.stringify(data);
  players.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// 取得 player 列表
function getPlayerList() {
  const list = [];
  players.forEach((data, playerId) => {
    list.push({
      playerId,
      config: data.config,
      actualWidth: data.actualWidth,
      connectedAt: data.connectedAt
    });
  });
  // 依連線時間排序
  list.sort((a, b) => a.connectedAt - b.connectedAt);
  return list;
}

// 通知 controllers 更新 player 列表
function notifyPlayersUpdate() {
  broadcastToControllers({
    type: 'players',
    list: getPlayerList()
  });
}

// 處理 WebSocket 連線
wss.on('connection', (ws) => {
  let role = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.error('Invalid JSON:', raw);
      return;
    }

    switch (msg.type) {
      case 'hello':
        role = msg.role;

        if (role === 'player') {
          playerId = msg.playerId || `player-${Date.now()}`;

          // 檢查是否已存在相同 playerId（可能是重連）
          if (players.has(playerId)) {
            const existing = players.get(playerId);
            // 關閉舊連線
            if (existing.ws.readyState === WebSocket.OPEN) {
              existing.ws.close();
            }
          }

          // 註冊 player
          const actualWidth = msg.actualWidth ? parseInt(msg.actualWidth) : null;
          console.log(`[HELLO] Player ${playerId} - actualWidth from msg: ${msg.actualWidth}, parsed: ${actualWidth}`);

          players.set(playerId, {
            ws,
            config: msg.config || {
              screenCount: 2,
              screenIndex: 1,
              offsetPx: 0
            },
            actualWidth: actualWidth,
            connectedAt: Date.now()
          });

          // 回應 init
          ws.send(JSON.stringify({
            type: 'init',
            startAt,
            now: Date.now(),
            playerId,
            config: players.get(playerId).config
          }));

          console.log(`Player connected: ${playerId}`);
          notifyPlayersUpdate();

        } else if (role === 'controller') {
          controllers.add(ws);

          // 回應 init 與 player 列表
          ws.send(JSON.stringify({
            type: 'init',
            startAt,
            now: Date.now()
          }));
          ws.send(JSON.stringify({
            type: 'players',
            list: getPlayerList()
          }));

          console.log('Controller connected');
        }
        break;

      case 'setConfig':
        // controller 設定某個 player 的配置
        if (role === 'controller' && msg.playerId && players.has(msg.playerId)) {
          const player = players.get(msg.playerId);
          player.config = {
            screenCount: msg.screenCount ?? player.config.screenCount,
            screenIndex: msg.screenIndex ?? player.config.screenIndex,
            offsetPx: msg.offsetPx ?? player.config.offsetPx ?? 0
          };

          // 通知該 player
          if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
              type: 'config',
              ...player.config
            }));
          }

          console.log(`Config updated for ${msg.playerId}:`, player.config);
          notifyPlayersUpdate();
        }
        break;

      case 'quickApply':
        // 一鍵套用：依連線順序分配 screenIndex，並自動計算累計偏移
        if (role === 'controller') {
          const list = getPlayerList();
          const n = list.length;
          let cumulativeOffset = 0;

          list.forEach((item, idx) => {
            const player = players.get(item.playerId);
            if (player) {
              // 計算此螢幕的偏移（前面所有螢幕寬度的總和）
              const offsetPx = cumulativeOffset;

              player.config = {
                screenCount: n,
                screenIndex: idx + 1,
                offsetPx: offsetPx
              };

              if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify({
                  type: 'config',
                  ...player.config
                }));
              }

              // 累加此螢幕的寬度（如果有回報的話）
              // 沒有回報寬度的螢幕不影響後面螢幕的偏移計算
              if (player.actualWidth) {
                cumulativeOffset += player.actualWidth;
              }

              console.log(`Player ${item.playerId}: offset=${offsetPx}, width=${player.actualWidth || 'unknown'}`);
            }
          });

          console.log(`Quick apply: ${n} players configured with auto offset`);
          notifyPlayersUpdate();
        }
        break;

      case 'updateMarquee':
        // controller 更新跑馬燈內容與樣式
        if (role === 'controller') {
          const marqueeData = {
            type: 'marquee',
            text: msg.text,
            speed: msg.speed || DEFAULT_SPEED_PX_SEC,
            styles: msg.styles || null,
            images: msg.images || []
          };

          // 記錄圖片資訊（只記錄長度，不記錄完整 base64）
          const imageInfo = marqueeData.images.map((img, i) => `img${i}:${img?.length || 0}chars`);
          // console.log('Marquee updated:', {
          //   text: msg.text?.substring(0, 30),
          //   hasStyles: !!msg.styles,
          //   imageCount: marqueeData.images.length,
          //   images: imageInfo
          // });

          broadcastToPlayers(marqueeData);
        }
        break;

      case 'reportWidth':
        // player 回報實際螢幕寬度
        if (role === 'player' && playerId && players.has(playerId)) {
          const player = players.get(playerId);
          const oldWidth = player.actualWidth;
          const newWidth = msg.actualWidth ? parseInt(msg.actualWidth) : null;
          player.actualWidth = newWidth;

          if (oldWidth !== newWidth) {
            console.log(`[REPORT] Player ${playerId} width: ${newWidth}px (was: ${oldWidth || 'unknown'})`);
            notifyPlayersUpdate();
          }
        }
        break;

      case 'resetStartAt':
        // 重置起始時間（需謹慎使用）
        if (role === 'controller') {
          const newStartAt = Date.now();
          broadcastToPlayers({
            type: 'reset',
            startAt: newStartAt,
            now: newStartAt
          });
          broadcastToControllers({
            type: 'reset',
            startAt: newStartAt,
            now: newStartAt
          });
          console.log('StartAt reset to:', newStartAt);
        }
        break;
    }
  });

  ws.on('close', () => {
    if (role === 'player' && playerId) {
      players.delete(playerId);
      console.log(`Player disconnected: ${playerId}`);
      notifyPlayersUpdate();
    } else if (role === 'controller') {
      controllers.delete(ws);
      console.log('Controller disconnected');
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// ============ Tick 定時廣播 ============
setInterval(() => {
  const tickMsg = {
    type: 'tick',
    now: Date.now(),
    startAt
  };

  broadcastToPlayers(tickMsg);
  broadcastToControllers(tickMsg);
}, TICK_INTERVAL_MS);

// ============ 啟動伺服器 ============
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     Multi-Screen Marquee Sync Server                   ║
╠════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                           ║
║                                                        ║
║  Endpoints:                                            ║
║    - Controller: http://localhost:${PORT}/controller      ║
║    - Player:     http://localhost:${PORT}/player          ║
║    - Health:     http://localhost:${PORT}/health          ║
║                                                        ║
║  Start time: ${new Date(startAt).toISOString()}                  ║
╚════════════════════════════════════════════════════════╝
  `);
});
