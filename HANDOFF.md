# 日序專案交接

更新日期：2026-11-13  
GitHub：<https://github.com/winebowl0516/20261106>  
目前分支：`main`

## 專案目標

「日序」是手機優先的個人行程與任務管理 Web 應用。現有前端提供月曆、每日安排、任務代幣、電子寵物、商店，以及 Google／LINE 登入。產品規格見 [`PRD.md`](PRD.md)。

## 目前狀態

- 前端是根目錄的單頁 [`index.html`](index.html)，目前用 GitHub Pages 發佈；網址預期為 `https://winebowl0516.github.io`。
- Google 登入由 Firebase Authentication 提供；LINE 登入由 LINE LIFF 提供。
- 行程與寵物目前各自存於瀏覽器 `localStorage`（`daily-sequence-v1`、`daily-sequence-pet-v1`），登入後仍未同步，換裝置或瀏覽器不會帶過去。
- Cloudflare Worker 的雲端同步 API 已新增，但尚未完成 Cloudflare 資源設定、部署或前端串接。相關檔案：[`cloudflare/worker/src/index.js`](cloudflare/worker/src/index.js)、[`cloudflare/worker/wrangler.jsonc`](cloudflare/worker/wrangler.jsonc)、[`cloudflare/worker/migrations/0001_initial.sql`](cloudflare/worker/migrations/0001_initial.sql)。
- 最近一次提交：`945473f Add Cloudflare worker`。工作分支為 `main`，遠端為 `origin`。

## 下一步工作（建議依序）

1. **部署前設定 Cloudflare**：建立 D1 資料庫並套用 migration；將產生的資料庫 ID 填入 `wrangler.jsonc`。確認 `LINE_LOGIN_CHANNEL_ID` 是 LINE Login Channel ID，`FIREBASE_PROJECT_ID` 與 Firebase 專案一致。`ALLOWED_ORIGIN` 必須精確符合前端正式網址的 Origin。
2. **部署 Worker**：在 `cloudflare/worker` 依 Wrangler 設定登入 Cloudflare、套用 D1 migration 並部署；記下 Worker URL，設定前端 API URL。不要把帳號密碼、API token 或其他私密憑證提交到 Git。
3. **把前端資料層接上同步 API**：登入完成後以目前登入提供者取得 ID token，呼叫 `GET /api/data` 載入雲端資料；建立／編輯／刪除安排，以及寵物、代幣、物品變更時更新雲端。保留本機資料作為離線或遷移來源，首次同步前要定義並實作本機與雲端資料的合併方式，避免直接覆蓋使用者資料。
4. **處理併發與帳號連結**：`PUT /api/data` 使用 `revision` 樂觀鎖；遇到 `409 Revision conflict` 要取回最新資料並安全合併／提示，不能靜默丟失變更。`POST /api/link` 可合併 Google 與 LINE 身分，但前端尚未提供連結帳號流程；實作時要清楚告知將合併兩邊資料。
5. **驗證端到端流程**：分別測試 Google、LINE 登入；初次建立雲端帳戶、資料新增／修改／刪除、不同瀏覽器登入後資料一致、兩種登入方式連結、離線／API 失敗，以及 revision 衝突。確認未登入不能存取資料，且 CORS 僅允許正式網站來源。
6. **更新文件**：部署完成後將 Worker URL、實際設定位置與操作方式補入本交接文件；不要寫入任何 secret。必要時同步修訂 [`PRD.md`](PRD.md) 對「登入僅驗證、資料僅本機」的舊描述。

## API 與資料格式速查

- `GET /api/data`：以 Bearer ID token 及 `X-Auth-Provider: google|line` 驗證；回傳 `{ revision, data }`。
- `PUT /api/data`：送出 `{ revision, data }`；成功時 revision 遞增，版本過期回 `409` 並附最新資料。
- `POST /api/link`：主要身分用一般 Authorization；另一登入方式的 token/provider 放在 `X-Link-Token`、`X-Link-Provider`。
- Worker 資料格式：`{ entries: [], pet: null, entryTombstones: {}, petUpdatedAt: 0 }`。安排刪除 tombstone、安排 `updatedAt`、寵物 `petUpdatedAt` 是跨裝置合併所需欄位；接前端同步時須確保本機資料有一致的建立／更新時間及刪除紀錄。
- Worker 限制單份文件約 1.7 MB；寵物照片與自訂背景目前是 Data URL，大小需納入此限制考量。

## 重要注意事項

- `wrangler.jsonc` 目前的 D1 `database_id` 是佔位字串；`LINE_LOGIN_CHANNEL_ID` 也是佔位字串。尚未部署前 API 不可用。
- `index.html` 含 Firebase Web App 設定與 LIFF ID（前端公開設定）；真正的秘密不可放在前端或提交到版本庫。
- PRD 含有待產品負責人確認的寵物飢餓速度、復原呈現及代幣平衡等假設，見第 13 節。
- 專案目前沒有獨立測試／建置流程。改動後至少手動走過登入及核心行程操作，再確認 GitHub Pages 與 Worker 部署結果。
