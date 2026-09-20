# INSTA360 自動備份設置指南

## 環境變數設置

在 `.env` 檔案中添加以下變數：

```env
# INSTA360 帳戶認證
INSTA360_EMAIL=guertu5566@gmail.com
INSTA360_PASSWORD=Abcd1000@

# Google Drive 設置
GOOGLE_INSTA360_FOLDER_ID=1i4p--LBe4K7C9p9aeGg5jsut96KhsT59
```

## 初始化 Google 授權

首次運行時，需要授權 Google Drive 訪問權限：

1. 向 LINE Bot 發送訊息：`綁定Google日曆`（會自動授權）
2. 或在瀏覽器訪問：`https://your-bot-url/oauth/google?userId=insta360_backup_service`

授權後，備份會自動將 token 保存到 MongoDB。

## 定時任務

- **每日備份時間**：每天 03:00（台北時間 Asia/Taipei）
- **刪除舊備份**：備份超過 7 天的文件會自動刪除
- **手動觸發**：`GET /cron/insta360-backup?secret=weather2024`

## 備份結構

在 Google Drive 中會按日期建立資料夾：

```
公路車錄影素材/
├── 2026-09-20/
│   ├── video_001.mp4
│   ├── photo_001.jpg
│   └── ...
├── 2026-09-21/
│   └── ...
```

## 監控備份狀態

1. **查看日誌**：檢查伺服器 console 輸出中 `[INSTA360]` 和 `[Google Drive]` 開頭的訊息
2. **備份紀錄**：MongoDB 中 `insta360_backups` collection 記錄所有備份
3. **手動備份**：可在任何時間調用 `/cron/insta360-backup` 端點

## 故障排查

### 登入失敗
- 確認 INSTA360_EMAIL 和 INSTA360_PASSWORD 正確
- 檢查 INSTA360 帳戶是否啟用了雙因素認證（可能需要額外配置）

### 備份失敗
- 檢查 Google Drive 授權 token 是否有效（查看 MongoDB 的 googleTokens 表）
- 確認 GOOGLE_INSTA360_FOLDER_ID 有效且帳號有寫入權限

### 下載速度慢
- INSTA360 相簾文件較大，初次備份可能耗時較長
- 建議在網絡連接穩定的環境運行

## 依賴安裝

```bash
npm install puppeteer axios
```

## 其他說明

- 首次運行 Puppeteer 會下載 Chromium，可能需要 200MB+ 空間
- 臨時文件保存在 `.insta360_tmp/` 目錄，備份後自動刪除
- 所有操作都會記錄在服務器日誌中
