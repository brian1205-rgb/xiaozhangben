# 小帳本 — 專案說明（給 Claude 與開發者）

個人用的記帳 App（只記支出），參考 CWMoney 的功能但外觀、名稱都是自己的。
做成 **PWA 網頁 App**：放在 GitHub Pages，用手機瀏覽器「加入主畫面」安裝。

- 網站：https://brian1205-rgb.github.io/xiaozhangben/
- 存放區：https://github.com/brian1205-rgb/xiaozhangben（Public，`main` 分支根目錄就是網站）
- 目前版本：**1.4.1**（`app.js` 的 `APP_VERSION`）

## 多台電腦開發（重要）
使用者會在不同電腦開發，GitHub 是唯一的正本：
- **每次開始工作前先 `git pull`**，避免兩台電腦的修改互相覆蓋。
- 新電腦第一次設定：
  1. 安裝 Git：`winget install --id Git.Git -e --source winget`（Git 可能不在 PATH，可用 `C:\Program Files\Git\cmd\git.exe`）
  2. 下載專案：`git clone https://github.com/brian1205-rgb/xiaozhangben.git`（建議放在英文路徑，例如 `Documents\xiaozhangben`；終端機工具不接受中文路徑）
  3. 設定 commit 身分（只對這個存放區）：`git config user.name brian1205-rgb`、`git config user.email brian1205-rgb@users.noreply.github.com`
  4. 第一次 push 會要求登入 GitHub：要在**使用者看得到的終端機分頁**執行 `git push`（背景 shell 無法跳出登入視窗），請使用者在跳出的視窗登入。之後就能直接 push。
- 這個存放區只有程式碼；**記帳資料在手機裡**，不在電腦或 GitHub 上。

## 使用者與合作方式（重要）
- 使用者**沒有程式開發經驗**，請用**繁體中文（台灣）**溝通，步驟要具體、一步一步。
- 程式都由 Claude 寫。流程：使用者提需求 → Claude 修改 → **在瀏覽器用手機尺寸（375×812）實測** → 測試沒問題後 **Claude 直接 commit 並 push 到 GitHub**（使用者已同意）→ 確認網站已更新 → 請使用者把手機 App 關掉重開。
- 只在使用者要求修改、且測試通過後才 push；commit 訊息用中文描述改了什麼。
- 介面偏好：淺色模式、內文 18px、首頁不要上方標題列、底部選單目前分頁要明顯。

## 檔案結構
```
（存放區根目錄 = 網站）
index.html            頁面骨架、底部選單
app.js                全部程式（無框架、無打包，原生 JS）
style.css             樣式（固定淺色）
sw.js                 Service Worker：network-first 離線快取。改了檔案要把 CACHE 版本 +1（目前 xiaozhangben-v7）
manifest.webmanifest  PWA 設定
icon-192.png / icon-512.png / apple-touch-icon.png   App 圖示（手繪暖色風）
_config.yml           GitHub Pages 設定：排除 CLAUDE.md；_ 開頭資料夾本來就不會發佈
_dev/tools/           開發工具（不會出現在網站上）
  serve.ps1           本機預覽伺服器：powershell -ExecutionPolicy Bypass -File _dev\tools\serve.ps1 -Port 8765
  icon.svg            App 圖示原始檔（1 號手繪暖色）
  render-icons.ps1    用 Edge headless 把 icon.svg 轉成三種尺寸 PNG
  icon-options/       當初給使用者選的 5 種圖示風格（1 手繪、2 扁平、3 小豬、4 水彩、5 印章）＋比較圖
.claude/launch.json   預覽伺服器設定（xiaozhangben-preview）
```

## 資料（存在手機瀏覽器 localStorage，**不能弄丟**）
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

## 功能現況（1.4.0）
- 首頁：月份切換、**這星期日曆**（有記錄的日子有圓點，可展開整月；左右滑動時日曆跟著手指移動，放開後平滑換週/月）、**今日／本週／本月**三格（點了切換清單範圍）、依日期分組的明細。選了某天按＋會預設記在那天。
- 記一筆：計算機鍵盤（可 + −）、主分類格子 → 次分類小按鈕（可不選）、付款方式、日期、備註。
- 報表：上方可多選帳戶（不選＝全部，只記在當次開啟，不存檔），依選的帳戶算主分類圓餅圖（前 5 名＋其他），點主分類展開次分類明細。
- 付款：每種付款方式本月花多少。
- 設定：分類管理（主/次分類新增、改名、刪除、排序）、範例資料、匯出 JSON 備份／還原、匯出 CSV、清除資料。

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
預算提醒、固定支出（每月自動記）、近幾個月趨勢圖、搜尋、發票載具匯入（需向財政部申請 API）、雲端同步、包成原生 App（Capacitor）。
