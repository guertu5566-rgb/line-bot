# Tesla（Tessie）整合設置指南

透過 [Tessie API](https://developer.tessie.com) 在 LINE 查詢與控制 Tesla。

## 1. 取得 Tessie Token

到 [Tessie 開發者設定](https://dash.tessie.com/settings/developer) 產生 API Token。
這個 Token 可以解鎖你的車，**不要放進 git、不要分享**。

## 2. 環境變數（Render → Environment）

```env
# Tessie API Token
TESSIE_API_TOKEN=你的token

# 允許操作車輛的 LINE userId（多個用逗號分隔）
# 對機器人傳「我的ID」可以查到自己的 userId
TESLA_OWNER_USER_ID=Uxxxxxxxxxxxxxxxx

# （選填）指定 VIN；沒填就用 Tessie 帳號內第一台啟用中的車
TESSIE_VIN=
```

沒設定 `TESLA_OWNER_USER_ID` 的話，任何人都不能操作車輛。

## 3. LINE 指令範例

| 說法 | 動作 |
|---|---|
| 車況、電量多少 | 電量、續航、充電、門鎖、車內外溫度、里程 |
| 車在哪 | 地址 + Google 地圖連結 |
| 開冷氣／冷氣開 22 度／關冷氣 | 空調（15~28°C） |
| 上鎖 | 鎖車 |
| 解鎖、開前車廂、開後車廂 | **需回覆「確認」才會執行**（2 分鐘內有效） |
| 開始充電／停止充電 | 充電 |
| 閃燈、按喇叭、喚醒 | 找車／喚醒 |

有 `GEMINI_API_KEY` 時用 Gemini 理解語意，否則用關鍵字比對。
含「提醒／記得」的句子仍交給提醒功能（例：「明天早上8點提醒我開冷氣」）。

車子休眠時指令可能要 30 秒以上，機器人會先回「執行中」，完成後再推播結果。

## 4. 在 Claude 中使用

Tessie 有官方 MCP 伺服器，不需要自己架：

- **claude.ai／Claude Desktop**：到 [claude.ai/directory/tessie](https://claude.ai/directory/tessie) 一鍵連接
- **Claude Code**：

```bash
claude mcp add --transport http tessie https://mcp.tessie.com --header "Authorization: Bearer 你的token"
```
