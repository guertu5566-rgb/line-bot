require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const chrono = require('chrono-node');
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

  // 查看提醒列表
  if (/^(提醒列表|查看提醒|我的提醒|列出提醒|有什麼提醒|有哪些提醒|所有提醒|顯示提醒)$/.test(text)) {
    return sendReminderList(userId);
  }

  // 刪除提醒
  const deleteMatch = text.match(/^(刪除|取消|移除|刪掉|砍掉)\s*[#＃]?(\d+)$/);
  if (deleteMatch) {
    return deleteReminder(userId, parseInt(deleteMatch[2]));
  }

  // 智慧解析
  const parsed = smartParse(text);
  if (parsed) {
    return saveReminder(userId, parsed.content, parsed.remindAt, event.replyToken);
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{
      type: 'text',
      text: '你好！我是提醒小秘書 📋\n\n設定提醒請說：\n「明天下午3點 開會」\n「幫我記得後天交報告」\n「一小時後提醒我喝水」\n「下週一早上9點 看醫生」\n「提醒我明晚8點追劇」\n\n其他指令：\n• 提醒列表\n• 刪除 編號'
    }]
  });
}

function smartParse(text) {
  const now = new Date();

  // 1. 先嘗試直接用 chrono-node 解析
  const direct = tryChronoparse(text, now);
  if (direct) return direct;

  // 2. 剝除觸發詞後再試
  const stripped = stripTriggers(text);
  if (stripped !== text) {
    const result = tryChronoparse(stripped, now);
    if (result) return result;
  }

  // 3. 相對時間解析（一小時後、30分鐘後 等）
  const relative = parseRelativeTime(text, now);
  if (relative) return relative;

  // 4. 模糊時段解析（今晚、明天早上 等沒有具體時間的）
  const fuzzy = parseFuzzyTime(text, now);
  if (fuzzy) return fuzzy;

  return null;
}

function stripTriggers(text) {
  const triggers = [
    '幫我記得', '提醒我', '別忘了', '記得要', '我要提醒自己',
    '幫我提醒', '幫我記', '記錄一下', '提醒一下', '請提醒我',
    '請幫我記得', '請幫我提醒', '記得', '不要忘記', '不能忘'
  ];
  let result = text;
  for (const t of triggers) {
    // 去掉開頭的觸發詞
    if (result.startsWith(t)) {
      result = result.slice(t.length).replace(/^[，,、\s]+/, '');
      break;
    }
  }
  // 去掉結尾的觸發詞
  for (const t of ['提醒我', '記得', '別忘了']) {
    if (result.endsWith(t)) {
      result = result.slice(0, result.length - t.length).replace(/[，,、\s]+$/, '');
      break;
    }
  }
  return result;
}

function tryChronoparse(text, now) {
  const results = chrono.zh.parse(text, now);
  if (results.length === 0) return null;
  const remindAt = results[0].date();
  if (remindAt <= now) return null;
  const content = text.replace(results[0].text, '').replace(/^[，,、\s]+|[，,、\s]+$/g, '') || text;
  return { remindAt, content };
}

function parseRelativeTime(text, now) {
  // 相對時間模式
  const patterns = [
    { regex: /(\d+)\s*小時後/, ms: (m) => parseInt(m[1]) * 3600000 },
    { regex: /半小時後/, ms: () => 1800000 },
    { regex: /一個半小時後/, ms: () => 5400000 },
    { regex: /(\d+)\s*分鐘後/, ms: (m) => parseInt(m[1]) * 60000 },
    { regex: /(\d+)\s*分後/, ms: (m) => parseInt(m[1]) * 60000 },
    { regex: /(\d+)\s*天後/, ms: (m) => parseInt(m[1]) * 86400000 },
    { regex: /(\d+)\s*週後/, ms: (m) => parseInt(m[1]) * 7 * 86400000 },
    { regex: /(\d+)\s*周後/, ms: (m) => parseInt(m[1]) * 7 * 86400000 },
  ];

  for (const p of patterns) {
    const m = text.match(p.regex);
    if (m) {
      const remindAt = new Date(now.getTime() + p.ms(m));
      const content = stripTriggers(text.replace(m[0], '').replace(/^[，,、\s]+|[，,、\s]+$/g, '')) || text;
      return { remindAt, content };
    }
  }
  return null;
}

function parseFuzzyTime(text, now) {
  // 日期關鍵詞對應
  const dateMap = [
    { regex: /今天|今日|今/, offset: 0 },
    { regex: /明天|明日|明/, offset: 1 },
    { regex: /後天|後日/, offset: 2 },
    { regex: /大後天/, offset: 3 },
    { regex: /下週一|下周一|下星期一/, weekday: 1 },
    { regex: /下週二|下周二|下星期二/, weekday: 2 },
    { regex: /下週三|下周三|下星期三/, weekday: 3 },
    { regex: /下週四|下周四|下星期四/, weekday: 4 },
    { regex: /下週五|下周五|下星期五/, weekday: 5 },
    { regex: /下週六|下周六|下星期六/, weekday: 6 },
    { regex: /下週日|下週天|下周日|下周天|下星期日|下星期天/, weekday: 0 },
  ];

  // 時段關鍵詞對應（小時）
  const timeMap = [
    { regex: /凌晨/, hour: 2 },
    { regex: /早上|早晨|清晨/, hour: 8 },
    { regex: /上午/, hour: 10 },
    { regex: /中午/, hour: 12 },
    { regex: /下午/, hour: 15 },
    { regex: /傍晚/, hour: 18 },
    { regex: /晚上|今晚|明晚|夜晚|晚間/, hour: 20 },
    { regex: /深夜/, hour: 23 },
  ];

  // 具體小時解析（三點、3點、三點半、3:30 等）
  const hourMatch = text.match(/([一二三四五六七八九十百千\d]+)\s*[點:：]\s*([0-5]?\d)?/);

  let baseDate = null;
  let hour = null;
  let minute = 0;

  // 找日期
  for (const d of dateMap) {
    if (d.regex.test(text)) {
      baseDate = new Date(now);
      if (d.offset !== undefined) {
        baseDate.setDate(baseDate.getDate() + d.offset);
      } else {
        // 下週某天
        const today = baseDate.getDay();
        let diff = d.weekday - today + 7;
        if (diff <= 7) diff += 7;
        baseDate.setDate(baseDate.getDate() + diff);
      }
      break;
    }
  }

  // 找時段
  for (const t of timeMap) {
    if (t.regex.test(text)) {
      hour = t.hour;
      break;
    }
  }

  // 找具體小時
  if (hourMatch) {
    const raw = hourMatch[1];
    const chMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };
    hour = chMap[raw] || parseInt(raw);
    if (hourMatch[2]) minute = parseInt(hourMatch[2]);
    // 半小時
    if (/點半/.test(text)) minute = 30;
    // 下午修正
    if (/下午|傍晚|晚上|晚間/.test(text) && hour < 12) hour += 12;
  }

  if (!baseDate && !hour) return null;

  if (!baseDate) baseDate = new Date(now);
  if (hour !== null) {
    baseDate.setHours(hour, minute, 0, 0);
  } else {
    // 只有日期沒有時間，預設早上9點
    baseDate.setHours(9, 0, 0, 0);
  }

  if (baseDate <= now) return null;

  // 提取內容（移除時間相關詞）
  const timeWords = /今天|明天|後天|大後天|今日|明日|後日|下週[一二三四五六日天]|下周[一二三四五六日天]|下星期[一二三四五六日天]|早上|上午|中午|下午|傍晚|晚上|深夜|凌晨|今晚|明晚|[一二三四五六七八九十百千\d]+\s*[點:：][0-5]?\d?|[點半]/g;
  let content = stripTriggers(text.replace(timeWords, '').replace(/\s+/g, ' ').trim()) || text;

  return { remindAt: baseDate, content };
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
      text: `✅ 已設定提醒！\n\n📌 ${content}\n⏰ ${formatTime(remindAt)}\n\n(編號 #${id})`
    }]
  });
}

async function sendReminderList(userId) {
  const now = Date.now();
  const reminders = db.get('reminders')
    .filter(r => r.userId === userId && !r.sent && r.remindAt > now)
    .sortBy('remindAt').take(10).value();

  if (reminders.length === 0) {
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: '📋 目前沒有待提醒的事項' }]
    });
    return;
  }

  const list = reminders.map(r =>
    `#${r.id} ⏰ ${formatTime(new Date(r.remindAt))}\n📌 ${r.message}`
  ).join('\n\n');

  await client.pushMessage({
    to: userId,
    messages: [{
      type: 'text',
      text: `📋 您的提醒列表：\n\n${list}\n\n輸入「刪除 編號」可刪除`
    }]
  });
}

async function deleteReminder(userId, id) {
  const before = db.get('reminders').size().value();
  db.get('reminders').remove({ id, userId }).write();
  const after = db.get('reminders').size().value();

  await client.pushMessage({
    to: userId,
    messages: [{
      type: 'text',
      text: before > after ? `✅ 已刪除提醒 #${id}` : `❌ 找不到提醒 #${id}`
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
  const due = db.get('reminders')
    .filter(r => !r.sent && r.remindAt <= now).value();

  for (const reminder of due) {
    try {
      await client.pushMessage({
        to: reminder.userId,
        messages: [{
          type: 'text',
          text: `⏰ 提醒時間到！\n\n📌 ${reminder.message}\n\n(提醒 #${reminder.id})`
        }]
      });
      db.get('reminders').find({ id: reminder.id })
        .assign({ sent: true }).write();
    } catch (e) {
      console.error('推播失敗：', e.message);
    }
  }
});

app.get('/', (req, res) => res.send('LINE Bot Secretary is running! 🤖'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
