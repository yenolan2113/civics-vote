# 公民課堂表態

給國高中公民課使用的即時表態投票工具。老師出題，學生用平板或 Chromebook 掃 QR Code 或輸入代碼匿名投票；討論後可以再投一輪，並排比較討論前後的立場變化。

## 功能

- 老師用 Google 帳號登入後出題，產生 4 碼房間代碼與 QR Code
- 學生不用登入、不用安裝，同一輪每台裝置只能投一次
- 結果預設隱藏，由老師決定何時公布
- 第二輪投票：顯示討論前後的長條圖、各選項增減的百分點，以及有多少人改變選擇

## 資料與隱私

- 資料存在老師自己的 Firebase 專案（Firestore），權限由 `firestore.rules` 控管
- 學生以匿名身分投票，不蒐集姓名、帳號或座號
- `js/firebase-config.js` 內的設定是網頁公開設定，不是密碼；請勿把任何真正的金鑰或學生個資放進這個 repo

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 學生輸入房間代碼 |
| `vote.html`、`js/vote.js` | 學生投票頁 |
| `teacher.html`、`js/teacher.js` | 老師登入、出題、投影結果 |
| `js/firebase-config.js` | Firebase 專案設定 |
| `firestore.rules` | 資料庫安全規則（需貼到 Firebase 控制台發布） |

## 在本機預覽

```bash
python3 -m http.server 8123
```

然後開啟 <http://localhost:8123>。

## 致謝

參考自 阿凱老師（桃園市龍潭區石門國小）的 **#3 學生即時投票系統**（MIT License，Copyright (c) 2026 黃凱揚）。本專案參考其功能構想、房間代碼設計與安全規則的寫法，程式為重新撰寫。

- 工具介紹頁：<https://cagoooo.github.io/Akai/tool/3/>
- 原始碼：<https://github.com/cagoooo/vote>
