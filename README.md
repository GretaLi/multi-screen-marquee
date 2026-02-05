# 多螢幕同步跑馬燈播放系統

一個可控制多台播放器的跑馬燈系統，支援多螢幕同步顯示，適用於展場、廣告牆等情境。

## 系統架構

```
┌─────────────────────────────────────────────────────────┐
│                    Node.js Server                        │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Express    │  │  WebSocket   │  │    Health     │  │
│  │  Static     │  │   Server     │  │    Check      │  │
│  │  Files      │  │   (sync)     │  │   /health     │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────┘
          │                 │
          ▼                 ▼
    ┌───────────┐    ┌─────────────────────────────────┐
    │Controller │    │         Players (1~N)           │
    │  /controller│   │  /player?screenIndex=1         │
    └───────────┘    │  /player?screenIndex=2         │
                     │  /player?screenIndex=N         │
                     └─────────────────────────────────┘
```

## 快速開始

### 本地開發

```bash
# 安裝依賴
npm install

# 啟動伺服器
npm start

# 開啟瀏覽器
# 控制台: http://localhost:3000/controller
# 播放器: http://localhost:3000/player
```

### 多螢幕測試

開啟多個播放器視窗，使用不同的 query 參數：

```
# 螢幕 1 (共 3 螢幕)
http://localhost:3000/player?playerId=screen-1&screenCount=3&screenIndex=1

# 螢幕 2
http://localhost:3000/player?playerId=screen-2&screenCount=3&screenIndex=2

# 螢幕 3
http://localhost:3000/player?playerId=screen-3&screenCount=3&screenIndex=3
```

---

## 專案結構

```
028_跨裝置跑馬燈/
├── server.js           # Node.js 主服務（WS + 靜態頁）
├── package.json        # 專案配置
├── README.md           # 說明文件
└── public/
    ├── controller.html # 控制台頁面
    └── player.html     # 播放器頁面
```

---

## 系統流程與事件格式

### WebSocket 事件

| 事件類型 | 方向 | 說明 |
|---------|------|------|
| `hello` | Client → Server | 連線註冊 |
| `init` | Server → Client | 初始化回應（startAt, now, config） |
| `tick` | Server → All | 定時校時（每 5 秒） |
| `config` | Server → Player | 下發配置更新 |
| `players` | Server → Controller | 廣播 player 列表 |
| `setConfig` | Controller → Server | 設定指定 player |
| `quickApply` | Controller → Server | 一鍵套用配置 |
| `marquee` | Server → Players | 更新跑馬燈內容 |
| `reset` | Server → All | 重置同步時間 |

### 事件格式範例

```javascript
// hello (player)
{ type: "hello", role: "player", playerId: "screen-1", config: {...} }

// hello (controller)
{ type: "hello", role: "controller" }

// init
{ type: "init", startAt: 1699999999999, now: 1700000000000, playerId: "screen-1", config: {...} }

// tick
{ type: "tick", now: 1700000005000, startAt: 1699999999999 }

// config
{ type: "config", screenCount: 3, screenIndex: 2, widthPx: 1920 }

// players
{ type: "players", list: [{ playerId: "screen-1", config: {...}, connectedAt: 1700000000000 }] }

// setConfig
{ type: "setConfig", playerId: "screen-1", screenCount: 3, screenIndex: 1 }

// quickApply
{ type: "quickApply", widthPx: null }
```

---

## 跑馬燈核心邏輯

### 位移計算公式

```javascript
// 1. 全域位移（所有螢幕共用）
globalX = -(timeSinceStart * speedPxPerSec)

// 2. 螢幕切片偏移（每台螢幕不同）
sliceOffset = (screenIndex - 1) * screenWidth

// 3. 顯示位移（實際套用的值）
displayX = globalX - sliceOffset

// 4. 無縫循環
displayX = displayX % contentWidth
if (displayX > 0) displayX -= contentWidth
```

### 視覺說明

```
螢幕配置: screenCount=3

              ┌────────┐ ┌────────┐ ┌────────┐
              │ 螢幕 1  │ │ 螢幕 2  │ │ 螢幕 3  │
              │ idx=1  │ │ idx=2  │ │ idx=3  │
              └────────┘ └────────┘ └────────┘
                  │          │          │
                  ▼          ▼          ▼
跑馬燈內容: ═════════════════════════════════════════►
            ← sliceOffset=0 →
                        ← sliceOffset=screenWidth →
                                    ← sliceOffset=screenWidth*2 →
```

---

## 邊界條件處理

### 1. 不同螢幕解析度

**策略 A：使用 100vw（同解析度最佳）**
- 預設行為
- 每台螢幕以自己的視窗寬度計算
- 適用於所有螢幕解析度相同的情境

**策略 B：指定固定寬度**
- 在 Controller 設定 `widthPx`
- 或在 URL 加上 `?widthPx=1920`
- 適用於螢幕解析度不同但物理尺寸相同

### 2. 網路延遲/漂移

- Server 每 5 秒廣播 `tick` 校時
- Player 使用 `serverNow + (performance.now() - lastSyncPerfNow)` 推估同步時間
- 重連後自動校正

### 3. 斷線重連

- 自動重連（指數退避：1s, 2s, 4s, ... 最大 30s）
- 斷線期間使用本地時間繼續播放（不凍結）
- 重連後接收 `init` 和 `tick` 校正時間

### 4. 字體一致性

- 使用 Google Fonts: Noto Sans TC
- Fallback: system-ui, Microsoft JhengHei, sans-serif
- 建議所有播放器使用相同瀏覽器

---

## Zeabur 部署計畫

### A. 服務配置

**服務類型**: Node.js

**啟動命令**: `npm start`

**Port**: 由環境變數 `PORT` 指定（Zeabur 自動提供）

### B. 環境變數

| 變數名 | 說明 | 預設值 |
|--------|------|--------|
| `PORT` | 服務埠號 | 3000（Zeabur 自動設定） |

### C. 路由配置

| 路徑 | 說明 |
|------|------|
| `/controller` | 控制台頁面 |
| `/player` | 播放器頁面 |
| `/health` | 健康檢查端點 |

### D. Zeabur 部署步驟

1. **建立專案**
   - 登入 Zeabur Dashboard
   - 建立新專案

2. **部署服務**
   - 選擇 Git 或上傳方式
   - 選擇 Node.js 服務類型
   - 確認 `package.json` 中有 `start` script

3. **設定網域**
   - 綁定自訂網域或使用 Zeabur 提供的網域
   - 確保 HTTPS 已啟用（WebSocket 需要 wss://）

4. **驗證部署**
   - 訪問 `/health` 確認服務正常
   - 訪問 `/controller` 確認控制台可用

### E. 冷啟動/暖機策略

```
開場前 10 分鐘:
├── 1. 開啟 /controller（維持 WebSocket 連線，防止服務休眠）
├── 2. 所有播放器開啟 /player?playerId=xxx&screenCount=N&screenIndex=M
├── 3. 確認所有播放器出現在控制台列表
├── 4. 一鍵套用配置（或手動調整）
└── 5. 控制台每 30 秒自動 fetch /health（內建 keep-alive）
```

**Keep-Alive 程式碼（已內建於 controller.html）:**
```javascript
setInterval(async () => {
  try {
    const res = await fetch('/health');
    console.log('Health check OK');
  } catch (e) {
    console.error('Health check failed');
  }
}, 30000);
```

---

## 現場 SOP

### 開場前 10 分鐘

1. **啟動控制台**
   - 開啟 `https://your-domain.zeabur.app/controller`
   - 確認連線狀態為「已連線」

2. **啟動所有播放器**
   - 每台裝置開啟：
     ```
     https://your-domain.zeabur.app/player?playerId=screen-1
     https://your-domain.zeabur.app/player?playerId=screen-2
     ...
     ```
   - 或使用預設參數：
     ```
     /player?playerId=screen-1&screenCount=3&screenIndex=1
     ```

3. **確認連線**
   - 控制台應顯示所有在線播放器
   - 確認數量正確

4. **套用配置**
   - 點擊「一鍵套用配置」按鈕
   - 系統自動依連線順序分配 screenIndex
   - 或手動調整每台的 screenCount/screenIndex

5. **進入全螢幕**
   - 各播放器按 F11 或點擊「全螢幕」按鈕
   - 關閉螢幕保護程式與自動休眠

### 開始播放

1. **檢查接縫**
   - 觀察螢幕 1 與螢幕 2 的接縫是否連續
   - 如有微縫，嘗試：
     - 調整 widthPx 參數（使用固定像素寬度）
     - 確認所有螢幕解析度相同

2. **調整跑馬燈內容**
   - 在控制台修改文字
   - 點擊「更新跑馬燈」
   - 確認所有播放器同步更新

### 展示中

1. **Wi-Fi 抖動處理**
   - 期望行為：播放器繼續播放，重連後自動同步
   - 觀察連線指示燈（右下角）：
     - 綠色：已連線
     - 黃色閃爍：重連中
     - 紅色：斷線

2. **除錯模式**
   - 播放器按 `D` 鍵顯示除錯面板
   - 可查看：FPS、同步狀態、位移值

### 結束

1. **關閉播放器**
   - 退出全螢幕（ESC 或 F11）
   - 關閉瀏覽器分頁

2. **關閉控制台**
   - 關閉控制台分頁

3. **重置（如需）**
   - 方法 A：點擊控制台「重置同步時間」按鈕
   - 方法 B：重新部署服務（Zeabur Dashboard）

---

## 疑難排解

### 播放器不同步

1. 確認所有播放器連線到同一伺服器
2. 檢查網路延遲（按 D 看除錯面板的 Connection 狀態）
3. 嘗試「重置同步時間」

### 跑馬燈有縫隙

1. 確認所有螢幕解析度相同
2. 如解析度不同，使用 widthPx 參數指定固定寬度
3. 確認字體已載入（等待幾秒）

### 無法連線

1. 確認 URL 正確
2. 確認服務已啟動（訪問 /health）
3. 確認 HTTPS/WSS（生產環境必須）
4. 檢查瀏覽器 Console 錯誤

### 畫面凍結

1. 播放器會在斷線時繼續播放（用本地時間）
2. 如完全凍結，重新整理頁面
3. 檢查瀏覽器是否被休眠（建議關閉省電模式）

---

## 參數說明

### Player URL 參數

| 參數 | 類型 | 預設值 | 說明 |
|------|------|--------|------|
| `playerId` | string | `player-{timestamp}` | 播放器識別碼 |
| `screenCount` | number | 2 | 總螢幕數 |
| `screenIndex` | number | 1 | 此螢幕位置（1~N） |
| `widthPx` | number | null | 固定螢幕寬度（px） |
| `speed` | number | 120 | 跑馬燈速度（px/sec） |

### 快捷鍵

| 按鍵 | 功能 |
|------|------|
| `F11` / `F` | 切換全螢幕 |
| `D` | 切換除錯面板 |

---

## 預設參數

- 預計裝置數：1～6 台
- 播放時間：1 小時（無限制）
- 跑馬燈速度：120 px/sec
- tick 校時：每 5 秒
- 預設配置：screenCount=2, screenIndex=1

---

## 技術棧

- **Backend**: Node.js + Express + ws
- **Frontend**: Vanilla HTML/CSS/JS
- **Font**: Noto Sans TC (Google Fonts)
- **Rendering**: requestAnimationFrame + CSS transform (GPU)
