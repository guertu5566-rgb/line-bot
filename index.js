require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const Groq = require('groq-sdk');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { google } = require('googleapis');

const adapter = new FileSync('reminders.json');
const db = low(adapter);
db.defaults({ reminders: [], nextId: 1, googleTokens: {} }).write();

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.messagingApi.MessagingApiClient(lineConfig);

// Groq AI 初始化
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Google OAuth2 初始化
function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `https://line-bot-secretary.onrender.com/oauth/google/callback`
  );
}

// Google OAuth2 授權路由
app.get('/oauth/google', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).send('Missing userId');

  const oauth2Client = getOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: userId,
    prompt: 'consent'
  });
  res.redirect(url);
});

// Google OAuth2 回調
app.get('/oauth/google/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or userId');

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    db.get('googleTokens').assign({ [userId]: tokens }).write();
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>✅ Google 日曆綁定成功！</h2>
        <p>您的 LINE 提醒小秘書現在會自動把提醒加入 Google 日曆</p>
        <p>可以關閉此視窗了</p>
      </body></html>
    `);
    // 通知 LINE 用戶綁定成功
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: '✅ Google 日曆綁定成功！\n\n以後設定提醒時，我也會自動幫您加入 Google 日曆 📅' }]
    });
  } catch (e) {
    console.error('Google OAuth callback error:', e.message);
    res.status(500).send('授權失敗，請重試');
  }
});

// 新增 Google 日曆事件
async function addToGoogleCalendar(userId, summary, startTime) {
  const tokens = db.get('googleTokens').get(userId).value();
  if (!tokens) return false;

  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);

    // 自動刷新 token
    oauth2Client.on('tokens', (newTokens) => {
      const merged = Object.assign({}, tokens, newTokens);
      db.get('googleTokens').assign({ [userId]: merged }).write();
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const endTime = new Date(startTime.getTime() + 30 * 60000); // 預設30分鐘

    await calendar.events.insert({
      calendarId: 'primary',
      resource: {
        summary: summary,
        start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Taipei' },
        end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Taipei' },
        reminders: {
          useDefault: false,
          overrides: [{ method: 'popup', minutes: 10 }]
        }
      }
    });
    return true;
  } catch (e) {
    console.error('Google Calendar 新增失敗：', e.message);
    return false;
  }
}

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

  // 綁定 Google 日曆指令
  if (/綁定.*google|連結.*google|google.*日曆|授權.*日曆|link.*google/i.test(text)) {
    const authUrl = `https://line-bot-secretary.onrender.com/oauth/google?userId=${userId}`;
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: `📅 請點以下連結授權 Google 日曆：\n\n${authUrl}\n\n授權後，每次設定提醒都會自動加入您的 Google 日曆！`
      }]
    });
  }

  let parsed = null;

  if (process.env.GROQ_API_KEY) {
    try {
      parsed = await parseWithGroq(text);
    } catch (e) {
      console.error('Groq 解析失敗，改用關鍵字：', e.message);
    }
  }

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

async function parseWithGroq(text) {
  const now = new Date();
  const nowStr = now.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long'
  });

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `你是LINE提醒機器人的語意解析器。現在台灣時間：${nowStr}
回傳純JSON（不要markdown代碼塊）：
{"intent":"set_reminder|list_reminders|delete_reminder|unknown","content":"提醒內容（去掉時間詞和觸發詞）","datetime":"ISO8601台灣時間或null","deleteId":數字或null}
規則：1.含提醒我/幫我記得/別忘了/X點/明天/後天/下週/小時後→set_reminder 2.含提醒列表/查看提醒→list_reminders 3.含刪除/取消+數字→delete_reminder 4.其他→unknown 5.datetime必須是未來時間 6.只有時段沒有具體時間：早上預設09:00，下午預設14:00，晚上預設20:00`
      },
      { role: 'user', content: text }
    ],
    temperature: 0.1,
    max_tokens: 200
  });

  const raw = completion.choices[0].message.content.trim()
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

  if (/提醒列表|查看提醒|我的提醒|列出提醒|有什麼提醒|所有提醒/.test(text)) {
    return { intent: 'list_reminders' };
  }

  const delMatch = text.match(/[刪取移][除消掉]\s*[#＃]?(\d+)/);
  if (delMatch) {
    return { intent: 'delete_reminder', deleteId: parseInt(delMatch[1]) };
  }

  const relMatch = text.match(/(\d+)\s*(小時|分鐘|分)\s*後/);
  if (relMatch) {
    const ms = relMatch[2] === '小時' ? 3600000 : 60000;
    const dt = new Date(now.getTime() + parseInt(relMatch[1]) * ms);
    const content = text.replace(relMatch[0], '').replace(/[幫我記得提醒我別忘了記得要]+/g, '').trim();
    return { intent: 'set_reminder', datetime: dt, content: content || text };
  }

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

  // 加入 Google 日曆
  const hasGoogle = db.get('googleTokens').get(userId).value();
  let calendarMsg = '';
  if (hasGoogle) {
    const added = await addToGoogleCalendar(userId, content, remindAt);
    calendarMsg = added ? '\n📅 已同步加入 Google 日曆' : '';
  }

  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: `✅ 提醒已設定！\n\n📌 ${content}\n⏰ ${formatTime(remindAt)}\n\n編號 #${id}${calendarMsg}`
    }]
  });
}

async function sendReminderList(userId, replyToken) {
  const now = Date.now();
  const reminders = db.get('reminders')
    .filter(r => r.userId === userId && !r.sent && r.remindAt > now)
    .sortBy('remindAt').take(10).value();

  const hasGoogle = db.get('googleTokens').get(userId).value();
  const googleStatus = hasGoogle ? '📅 Google 日曆：已連結' : '📅 Google 日曆：未連結（傳送「綁定Google日曆」來連結）';

  const msg = reminders.length === 0
    ? `📋 目前沒有待提醒的事項\n\n${googleStatus}`
    : `📋 您的提醒列表：\n\n${reminders.map(r =>
        `#${r.id} ⏰ ${formatTime(new Date(r.remindAt))}\n📌 ${r.message}`
      ).join('\n\n')}\n\n輸入「刪除 編號」可刪除\n\n${googleStatus}`;

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
      text: '你好！我是提醒小秘書 📋\n\n📝 設定提醒範例：\n「明天下午3點開會」\n「幫我記得後天交報告」\n「一小時後提醒我喝水」\n「下週一早上9點看醫生」\n「提醒我今晚8點追劇」\n\n📋 查看提醒：「提醒列表」\n🗑️ 刪除提醒：「刪除 1」\n📅 連結Google日曆：「綁定Google日曆」'
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
