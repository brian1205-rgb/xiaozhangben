# 小帳本 — 專案說明（給 Claude 與開發者）

記帳 App（只記支出），有個人帳本和跟家人共用的家用帳本，參考 CWMoney 的功能但外觀、名稱都是自己的。
做成 **PWA 網頁 App**：放在 GitHub Pages，用手機瀏覽器「加入主畫面」安裝。

- 網站：https://brian1205-rgb.github.io/xiaozhangben/
- 存放區：https://github.com/brian1205-rgb/xiaozhangben（Public，`main` 分支根目錄就是網站）
- 目前版本：**2.6.1**（`app.js` 的 `APP_VERSION`）

## 多台電腦開發（重要）
使用者會在不同電腦開發，GitHub 是唯一的正本：
- **每次開始工作前先 `git pull`**，避免兩台電腦的修改互相覆蓋。
- 新電腦第一次設定：
  1. 安裝 Git：`winget install --id Git.Git -e --source winget`（Git 可能不在 PATH，可用 `C:\Program Files\Git\cmd\git.exe`）
  2. 下載專案：`git clone https://github.com/brian1205-rgb/xiaozhangben.git`（建議放在英文路徑，例如 `Documents\xiaozhangben`；終端機工具不接受中文路徑）
  3. 設定 commit 身分（只對這個存放區）：`git config user.name brian1205-rgb`、`git config user.email brian1205-rgb@users.noreply.github.com`
  4. 第一次 push 會要求登入 GitHub：要在**使用者看得到的終端機分頁**執行 `git push`（背景 shell 無法跳出登入視窗），請使用者在跳出的視窗登入。之後就能直接 push。
- 這個存放區只有程式碼；**記帳資料在 Firebase 雲端**（2.0.0 起），不在 GitHub 上。

## 使用者與合作方式（重要）
- 使用者**沒有程式開發經驗**，請用**繁體中文（台灣）**溝通，步驟要具體、一步一步。
- 程式都由 Claude 寫。流程：使用者提需求 → Claude 修改 → **在瀏覽器用手機尺寸（375×812）實測** → 測試沒問題後 **Claude 直接 commit 並 push 到 GitHub**（使用者已同意）→ 確認網站已更新 → 請使用者把手機 App 關掉重開。
- 只在使用者要求修改、且測試通過後才 push；commit 訊息用中文描述改了什麼。
- 介面偏好：淺色模式、內文 18px、首頁不要上方標題列、底部選單目前分頁要明顯。
- 圖示用表情符號：index.html 載入 Google Fonts 的 Noto Color Emoji，讓 Windows 和 Android 長得一樣（style.css 最後有指定圖示元素用這個字型）。
- 電腦版（2.1.0 起）：同一個網址，螢幕寬 960px 以上自動換排版（style.css 最後的 @media 區塊）。改畫面時手機（375×812）和電腦（1280×800）兩種尺寸都要測。

## 檔案結構
```
（存放區根目錄 = 網站）
index.html            頁面骨架、底部選單
app.js                全部程式（ES module，無框架、無打包；從 gstatic CDN 載入 Firebase 10.14.1）
style.css             樣式（固定淺色）
sw.js                 Service Worker：network-first 離線快取，抓檔用 cache:no-cache（GitHub Pages 有 max-age=600，不這樣手機會用 10 分鐘內的舊檔）。改了檔案要把 CACHE 版本 +1（目前 xiaozhangben-v28）；gstatic 的 Firebase 檔案和 Google 字型用 cache-first
manifest.webmanifest  PWA 設定
icon-192.png / icon-512.png / apple-touch-icon.png   App 圖示（手繪暖色風）
_config.yml           GitHub Pages 設定：排除 CLAUDE.md；_ 開頭資料夾本來就不會發佈
_dev/firestore.rules  Firestore 安全規則（正本；改了要貼到 Firebase 控制台 → Firestore → 規則 → 發布）
_dev/tools/           開發工具（不會出現在網站上）
  serve.ps1           本機預覽伺服器：powershell -ExecutionPolicy Bypass -File _dev\tools\serve.ps1 -Port 8765
  icon.svg            App 圖示原始檔（1 號手繪暖色）
  render-icons.ps1    用 Edge headless 把 icon.svg 轉成三種尺寸 PNG
  icon-options/       當初給使用者選的 5 種圖示風格（1 手繪、2 扁平、3 小豬、4 水彩、5 印章）＋比較圖
.claude/launch.json   預覽伺服器設定（xiaozhangben-preview）
```

## 雲端（2.0.0 起）
- Firebase 專案：`xiaozhangben-7d819`（使用者的 Google 帳號，Spark 免費方案）。控制台：https://console.firebase.google.com/project/xiaozhangben-7d819
  - Authentication：只開 Google 登入；授權網域已加 `brian1205-rgb.github.io`（localhost 預設就有）。
  - Firestore：asia-east1（台灣），正式版模式，規則見 `_dev/firestore.rules`。
  - 網頁設定（apiKey 等）寫在 `app.js`，這是公開資訊，安全靠規則。
- 資料結構：
  - `ledgers/{id}`：`{type:'personal'|'family', name, owner(uid), ownerEmail, memberEmails[](小寫), members{uid:{name,email}}, accounts[], categories{expense,income}, budget, recurring[], shortcuts[], apiKey?, createdAt, updatedAt}`。個人帳本 id 固定 `p_<uid>`，家用帳本 `f_<亂數>`。
  - `ledgers/{id}/txs/{txId}`：每筆記錄（欄位同下方舊格式，另有 `by`(uid)／`byName` 記錄是誰記的）。
- 規則重點：只有 `memberEmails` 裡的人能讀寫；只有建立者能改成員、刪帳本；個人帳本成員固定只有本人。**規則不允許讀取不存在的文件**（getDoc 會得到 permission-denied，程式把它當成「還沒建立」）。`apiKeys/{金鑰}` 任何人都能 get（不能 list），只有該帳本成員能建立、更新、刪除。
- 程式：`save()` 會把目前 `data` 跟上次同步的內容比對，只寫有變的部分（離線先存手機快取）；`onSnapshot` 即時收別人的修改。所有帳本都在背景同步（`books`），切換帳本只是換畫面，不重新載入。畫面程式仍操作 `data`（格式同舊版）。
- 舊資料搬家：登入時如果手機 localStorage 有舊資料、且這支手機還沒搬過（`xiaozhangben:migrated:<uid>`），就上傳到個人帳本；雲端個人帳本沒有記錄時直接用手機的分類／付款方式，有記錄時合併。手機裡的舊資料不刪。
- 測試：本機預覽登入要**使用者本人**在瀏覽器按 Google 登入（Claude 不能代登入）。測試會寫到使用者真正的雲端資料，測完要清掉（家用帳本可用「刪除這本家用帳本」，個人帳本用「清除個人帳本的所有資料」）。
## 舊版資料格式（1.x 存在手機 localStorage，2.0 的帳本內容沿用同樣格式）
- localStorage key：`xiaozhangben:v1`（**不要改名**），資料格式 `version: 2`。
- 結構：
  - `accounts`：付款方式 `{id, name, icon, initial}`
  - `categories.expense`：主分類 `{id, name, icon, subs: [{id, name}]}`
  - `categories.income`：舊版遺留，不顯示但保留
  - `txs`：`{id, type, amount, categoryId, subCategoryId, accountId, toAccountId, date:'YYYY-MM-DD', note, createdAt, updatedAt, demo?}`
  - `prefs.lastAccountId`
- 1.1.0 起只記支出：舊的 income／transfer 記錄**保留但不顯示**。
- 1.2.0 起主分類＋次分類：`normalize()` 發現舊的單層分類會呼叫 `migrateFlat()` 自動轉換（依名稱對應 `DEFAULT_TREE`，沿用舊 id），載入後立刻存檔。
- `demo: true` 的是範例資料（設定頁可一鍵加入／移除，不影響真實記錄）。
- **改資料格式一定要寫轉換程式並測舊資料**；匯入備份也會經過 `normalize()`。

## 功能現況（2.6.0）
- 首頁：月份切換、**這星期日曆**（有記錄的日子有圓點，可展開整月；左右滑動時日曆跟著手指移動，放開後平滑換週/月）、**今日／本週／本月**三格（點了切換清單範圍）、依日期分組的明細（每筆第二行是彩色小標籤：主分類灰、付款方式藍、記錄者橘；備註在第三行）。選了某天按＋會預設記在那天。
- 2.3.0 新增（帳本文件多了 `budget`、`recurring[]`、`shortcuts[]`，見 `normExtras()`；`META_KEYS` 決定哪些帳本欄位會同步）：
  - 搜尋與篩選：明細頁「搜尋明細」→ 搜備註／主分類／次分類，篩日期區間、付款方式、記錄者（家用）；顯示筆數和合計（`ui.search`、`viewSearch()`，打字只更新 `#searchResults`）。
  - 每月預算：設定頁填整本帳本的月預算，首頁統計下方顯示已花／還剩／進度條（80% 橘、超支紅），家用共用。
  - 固定支出：設定頁新增（名稱、金額、每月幾號、分類、付款方式）；到期且本月未處理時首頁出現提醒，「記一筆」帶入內容（存檔後 `lastDone` = 本月）、「這個月略過」。
  - 常用捷徑：記一筆上方一排捷徑（帶入分類、付款方式、可選預設金額），「＋ 存成捷徑」或設定頁管理。
- 2.4.0 匯入 Excel（批次新增，用途：AI 先把信用卡帳單整理成 Excel，使用者修改後上傳）：
  - 入口：設定頁「匯入 Excel」、電腦版左邊選單「📥 匯入 Excel」（`#excelFile`）。讀檔用 SheetJS 0.20.3，第一次用到才從 `cdn.sheetjs.com` 動態 import（需要網路）。
  - 欄位（第一列欄位名稱，順序不拘，`IMPORT_COLS` 有別名）：日期、金額、主分類、次分類、付款方式、備註。小帳本自己匯出的 CSV 可直接匯回；CSV 先試 UTF-8 再試 Big5；「合計」列略過。
  - 日期可為 Excel 日期、2026/11/3、2026-11-03、20261103、民國 115/11/03、只有月/日（猜年份）。分類依名稱對應（主分類欄也可寫「飲食 › 早餐」）；付款方式依名稱，空白用預設（名稱含「信用卡」的優先）。
  - 預覽（`#modal` 的 `.import-card`，`imp` 狀態、`renderImport()`）：找不到分類標紅可直接選；負數金額、日期錯誤不能匯入；同日期同金額標「可能重複」預設不勾；可一次改全部付款方式、全選／全不選。點背景不會關閉。
  - 匯入的記錄多一個 `importId`（同一次匯入相同）；設定頁列出最近 5 批，可「刪除這批」。也可下載 Excel 範本（明細＋分類清單＋付款方式＋說明）。
  - 2.5.0 給 AI 讀分類的唯讀 API：設定頁「AI 整理帳單（分類 API）」產生網址（Firestore REST：`firestore.googleapis.com/v1/projects/xiaozhangben-7d819/databases/(default)/documents/apiKeys/<金鑰>?mask.fieldPaths=json`，不用登入、不需 Blaze）。帳本文件存 `apiKey`；`apiKeys/{金鑰}` = `{ledgerId, json, updatedAt}`，`json` 是分類名稱、次分類、付款方式名稱和 Excel 欄位說明（`apiPayload()`）。分類／付款方式改了或 App 開啟時 `publishApi()` 自動更新（內容沒變不寫）。可重新產生（舊的刪掉）、停用。「複製給 AI 的指令」(`aiPrompt()`) 分類清單直接寫在指令最前面（Gemini 等聊天 AI 不能開外部網址），API 網址只附在最後給能上網的 AI 工具，AI 不能產生 .xlsx 時改輸出表格；剪貼簿不能用時改開文字框讓使用者自己複製。
  - 2.6.0 用文字一次修改全部分類：支出分類管理最下面「✏️ 用文字一次修改全部分類」，文字框格式跟給 AI 的指令一樣（`catLines()`，一行「主分類：次分類、次分類」）。`parseCatText()` 檢查重複、長度；`planCats()` 依名稱比對沿用 id（同主分類底下同名次分類優先保留；在別的主分類找到唯一同名次分類就搬過去；舊主分類名稱變成次分類時，記錄改成「新主分類 › 該次分類」），預覽顯示新增／搬移／刪除和受影響筆數，按「套用」才 `remap()` txs、recurring、shortcuts。刪掉的主分類記錄改成「其他」（沒有「其他」才變未分類），刪掉的次分類記錄只留主分類。新主分類圖示用 `CAT_ICONS` 猜，猜不到 📦。2026/11/22 用它把個人、家用兩個帳本換成新分類（新增「👶 宥廷」）。
- 記一筆：計算機鍵盤（可 + −）、主分類格子 → 次分類小按鈕（可不選）、付款方式、日期、備註。所有確認都用 App 內的視窗：askConfirm()（取消／確定）和 notice()（只有「知道了」），index.html 的 #confirm 疊層；不要再用瀏覽器內建的 confirm/alert。
- 報表：上方可多選帳戶（不選＝全部，只記在當次開啟，不存檔），依選的帳戶算；近 12 個月支出長條圖（虛線＝有記帳月份的平均，點長條切換月份）；主分類圓餅圖（前 5 名＋其他），點主分類展開次分類明細。
- 付款：每種付款方式本月花多少。
- 電腦版：左邊固定選單（記一筆、各分頁、帳本切換）；明細頁左邊固定顯示整月日曆（沒有切換單週按鈕）＋統計、右邊明細；報表頁總額和 12 個月長條圖並排、圓餅圖和分類清單並排；記一筆和表單是畫面中間的視窗；快捷鍵 N 記一筆、← → 換月份、Esc 關閉視窗、記帳時可直接用鍵盤打金額。
- 登入／帳本：Google 登入；個人帳本＋家用帳本；有兩本以上時月份列左邊有帳本按鈕，點一下就換到下一本；家用帳本明細顯示是誰記的。
- 設定：帳號（登出）、帳本清單／建立家用帳本、家用帳本成員（建立者可用 Gmail 加入／移除、刪除帳本）、分類管理（主/次分類新增、改名、刪除、排序）、範例資料、匯出 JSON 備份／還原、匯出某個月的明細（選月份，CSV 最後一行是合計；報表頁底下也有按鈕）、匯出全部明細 CSV、清除資料。家用帳本的 CSV 多一欄「記錄者」。

## 測試方式
1. 啟動預覽：`preview_start` 用 `xiaozhangben-preview`，或自己執行 serve.ps1 再用瀏覽器開 http://localhost:8765/
2. 瀏覽器設成手機尺寸 375×812 實際點按測試；資料可用設定頁的「加入範例資料」。
3. 改到資料格式時，先把舊格式資料寫進 localStorage 再重新整理，確認轉換正確。
4. 注意：本機預覽時 Service Worker 可能註冊失敗（只在本機預覽發生，正式網站正常），不用理會。

## 上傳（部署）
```
git add -A
git commit -m "說明改了什麼"
git push origin main
```
GitHub Pages 約 1 分鐘更新；可抓 `https://brian1205-rgb.github.io/xiaozhangben/app.js` 確認 `APP_VERSION`。
commit 身分：`brian1205-rgb` / `brian1205-rgb@users.noreply.github.com`（不要用使用者的私人信箱）。

## 手機端提醒
- 改圖示後，主畫面圖示要重新「加入主畫面」才會換；**iPhone 刪掉主畫面 App 可能連資料一起刪**，一定先在 App 內匯出備份再還原。
- 一般更新：手機把 App 完全關掉再開（有時要兩次）。

## 之後可以做的（使用者提過或討論過）
分類預算（餐飲、交通各自的預算）、發票載具匯入（需向財政部申請 API）、包成原生 App（Capacitor）。
