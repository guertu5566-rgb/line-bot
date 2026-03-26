require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const adapter = new FileSync('reminders.json');
const db = low(adapter);
db.defaults({ reminders: [], nextId: 1 }).write();

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.messagingApi.MessagingApiClient(lineConfig);

// Gemini AI 初始化
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  res.json({ status: 'ok' });
  for (const event of req.body.events) {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleMessage(event);
    }
  }
});

async function handleMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();

  let parsed = null;

  // 先用 Gemini 解析意圖
  if (process.env.GEMINI_API_KEY) {
    try {
      parsed = await parseWithGemini(text);
    } catch (e) {
      console.error('Gemini 解析失敗，改用關鍵字：', e.message);
    }
  }

  // Gemini 沒成功就 fallback 到關鍵字
  if (!parsed) {
    parsed = parseByKeyword(text);
  }

  if (!parsed) {
    return sendHelp(event.replyToken);
  }

  switch (parsed.intent) {
    case 'list_reminders':
      return sendReminderList(userId, event.replyToken);
    case 'delete_reminder':
      return deleteReminder(userId, parsed.deleteId, event.replyToken);
    case 'set_reminder':
      if (parsed.datetime && parsed.datetime > new Date()) {
        return saveReminder(userId, parsed.content, parsed.datetime, event.replyToken);
      } else {
        return client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '❓ 我沒辦法辨識提醒時間，請試著說「明天下午3點 開會」' }]
        });
      }
    default:
      return sendHelp(event.replyToken);
  }
}

async function parseWithGemini(text) {
  const now = new Date();
  const nowStr = now.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long'
  });

  const prompt = `你是LINE提醒機器人的語意解析器。
現在台灣時間：${nowStr}

用戶訊息：「${text}」

請回傳純JSON（不要markdown代碼塊、不要多餘文字）：
{
  "intent": "set_reminder" 或 "list_reminders" 或 "delete_reminder" 或 "unknown",
  "content": "提醒事項內容（去掉時間詞和觸發詞，保留核心事項）",
  "datetime": "ISO 8601格式的台灣時間，例如2025-03-27T15:00:00+08:00，如果沒有時間則為null",
  "deleteId": 數字或null
}

判斷規則：
1. 含「提醒我、幫我記得、別忘了、記得、X點、明天、後天、下週、等等、分鐘後、小時後」→ intent = "set_reminder"
2. 含「提醒列表、查看提醒、我的提醒、列出提醒」→ intent = "list_reminders"
3. 含「刪除、取消、移除」+數字 → intent = "delete_reminder"，deleteId = 數字
4. 其他 → intent = "unknown"
5. datetime 必須是未來的時間（晚於現在）
6. 如果只說時段沒說幾點（如「明天早上」），預設09:00；「今晚」預設20:00`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim()
    .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  const data = JSON.parse(raw);

  return {
    intent: data.intent,
    content: data.content || text,
    datetime: data.datetime ? new Date(data.datetime) : null,
    deleteId: data.deleteId || null
  };
}

function parseByKeyword(text) {
  const now = new Date();

  // 查看列表
  if (/提醒列表|查看提醒|我的提醒|列出提醒|有什麼提醒|所有提醒/.test(text)) {
    return { intent: 'list_reminders' };
  }

  // 刪除提醒
  const delMatch = text.match(/[刪取移][除消掉]\s*[#＃]?(\d+)/);
  if (delMatch) {
    return { intent: 'delete_reminder', deleteId: parseInt(delMatch[1]) };
  }

  // 相對時間
  const relMatch = text.match(/(\d+)\s*(小時|分鐘|分)\s*後/);
  if (relMatch) {
    const ms = relMatch[2] === '小時' ? 3600000 : 60000;
    const dt = new Date(now.getTime() + parseInt(relMatch[1]) * ms);
    const content = text.replace(relMatch[0], '').replace(/[幫我記得提醒我別忘了記得要]+/g, '').trim();
    return { intent: 'set_reminder', datetime: dt, content: content || text };
  }

  // 半小時後
  if (/半小時後/.test(text)) {
    const dt = new Date(now.getTime() + 1800000);
    const content = text.replace('半小時後', '').replace(/[幫我記得提醒我別忘了]+/g, '').trim();
    return { intent: 'set_reminder', datetime: dt, content: content || text };
  }

  return null;
}

async function saveReminder(userId, content, remindAt, replyToken) {
  const id = db.get('nextId').value();
  db.get('reminders').push({
    id, userId,
    message: content,
    remindAt: remindAt.getTime(),
    sent: false
  }).write();
  db.set('nextId', id + 1).write();

  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: `✅ 提醒已設定！\n\n📌 ${content}\n⏰ ${formatTime(remindAt)}\n\n編號 #${id}`
    }]
  });
}

async function sendReminderList(userId, replyToken) {
  const now = Date.now();
  const reminders = db.get('reminders')
    .filter(r => r.userId === userId && !r.sent && r.remindAt > now)
    .sortBy('remindAt').take(10).value();

  const msg = reminders.length === 0
    ? '📋 目前沒有待提醒的事項'
    : `📋 您的提醒列表：\n\n${reminders.map(r =>
        `#${r.id} ⏰ ${formatTime(new Date(r.remindAt))}\n📌 ${r.message}`
      ).join('\n\n')}\n\n輸入「刪除 編號」可刪除`;

  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: msg }]
  });
}

async function deleteReminder(userId, id, replyToken) {
  const before = db.get('reminders').size().value();
  db.get('reminders').remove({ id, userId }).write();
  const after = db.get('reminders').size().value();

  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: before > after ? `✅ 已刪除提醒 #${id}` : `❌ 找不到提醒 #${id}`
    }]
  });
}

async function sendHelp(replyToken) {
  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: '你好！我是提醒小秘書 📋\n\n📝 設定提醒範例：\n「明天下午3點開會」\n「幫我記得後天交報告」\n「一小時後提醒我喝水」\n「下週一早上9點看醫生」\n「提醒我今晚8點追劇」\n\n📋 查看提醒：「提醒列表」\n🗑️ 刪除提醒：「刪除 1」'
    }]
  });
}

function formatTime(date) {
  return date.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  });
}

cron.schedule('* * * * *', async () => {
  const now = Date.now();
  const due = db.get('reminders').filter(r => !r.sent && r.remindAt <= now).value();
  for (const reminder of due) {
    try {
      await client.pushMessage({
        to: reminder.userId,
        messages: [{
          type: 'text',
          text: `⏰ 提醒時間到！\n\n📌 ${reminder.message}\n\n(提醒 #${reminder.id})`
        }]
      });
      db.get('reminders').find({ id: reminder.id }).assign({ sent: true }).write();
    } catch (e) {
      console.error('推播失敗：', e.message);
    }
  }
});

app.get('/', (req, res) => res.send('LINE Bot Secretary is running! 🤖'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
