require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const Groq = require('groq-sdk');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { google } = require('googleapis');
const https = require('https');

const adapter = new FileSync('reminders.json');
const db = low(adapter);
db.defaults({ reminders: [], nextId: 1, googleTokens: {}, weatherSubscribers: [] }).write();

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.messagingApi.MessagingApiClient(lineConfig);

// Groq AI 初始化（可選）
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// HTTP GET 工具函數
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.substring(0, 100))); }
      });
    }).on('error', reject);
  });
}

// 天氣圖示對應函數
function getWeatherIcon(weather) {
  if (!weather) return '🌤️';
  return weather.includes('雷') ? '⛈️' : weather.includes('雨') ? '🌧️' :
         weather.includes('陰') ? '☁️' : weather.includes('多雲') ? '⛅' : '☀️';
}

// 取得桃園中壢天氣
async function fetchZhongliWeather() {
  const apiKey = process.env.CWA_API_KEY;
  if (!apiKey) {
    console.error('[天氣] CWA_API_KEY 未設置');
    return null;
  }

  try {
    // 中央氣象署 F-D0047-007：桃園市鄉鎮天氣預報（含中壢區）
    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-007?Authorization=${apiKey}&locationName=%E4%B8%AD%E5%A3%A2%E5%8D%80&elementName=Wx,MinT,MaxT,PoP12h,UVI`;
    console.log('[天氣] 正在取得天氣資料...');
    const data = await httpsGet(url);
    console.log('[天氣] API 回應:', JSON.stringify(data).substring(0, 200));

    // 找出「中壢區」的數據
    const locations = data.records?.Locations?.[0]?.Location || [];
    const location = locations.find(loc => loc.LocationName === '中壢區');
    if (!location) {
      console.error('[天氣] 找不到中壢區的數據');
      return null;
    }

    // 提取所需的數據（根據 ElementName 分類）
    let wx = '無資料', minT = '-', maxT = '-', pop = '-', uvi = '-';

    for (const el of location.WeatherElement || []) {
      if (!el.Time || !el.Time[0]) continue;
      const values = el.Time[0].ElementValue?.[0] || {};

      if (el.ElementName === '天氣現象') wx = values.Weather || wx;
      else if (el.ElementName === '最低溫度') minT = values.MinTemperature || minT;
      else if (el.ElementName === '最高溫度') maxT = values.MaxTemperature || maxT;
      else if (el.ElementName === '12小時降雨機率') pop = values.ProbabilityOfPrecipitation || pop;
      else if (el.ElementName === '紫外線指數') uvi = values.UVIndex || uvi;
    }

    const wxIcon = getWeatherIcon(wx);

    const today = new Date().toLocaleDateString('zh-TW', {
      timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'long'
    });

    return `🌤️ 桃園中壢今日天氣\n${today}\n\n` +
           `${wxIcon} 天氣：${wx}\n` +
           `🌡️ 氣溫：${minT}°C ～ ${maxT}°C\n` +
           `☔ 降雨機率：${pop}%\n` +
           `☀️ 紫外線：${uvi}\n\n` +
           `資料來源：中央氣象署`;
  } catch (e) {
    console.error('天氣取得失敗：', e.message);
    return null;
  }
}

// 取得桃園中壢一週天氣預報
async function fetchZhongliWeatherWeekly() {
  const apiKey = process.env.CWA_API_KEY;
  if (!apiKey) {
    console.error('[天氣] CWA_API_KEY 未設置');
    return null;
  }

  try {
    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-007?Authorization=${apiKey}&locationName=%E4%B8%AD%E5%A3%A2%E5%8D%80&elementName=Wx,MinT,MaxT,PoP12h,UVI`;
    const data = await httpsGet(url);

    const locations = data.records?.Locations?.[0]?.Location || [];
    const location = locations.find(loc => loc.LocationName === '中壢區');
    if (!location) {
      console.error('[天氣] 找不到中壢區的數據');
      return null;
    }

    // 按日期分組天氣數據
    const dailyData = {};

    for (const el of location.WeatherElement || []) {
      if (!el.Time) continue;

      for (const timeSlot of el.Time) {
        if (!timeSlot.StartTime || !timeSlot.ElementValue?.[0]) continue;

        const date = timeSlot.StartTime.substring(0, 10); // YYYY-MM-DD
        if (!dailyData[date]) {
          dailyData[date] = { wx: '無資料', minT: '-', maxT: '-', pop: '-', uvi: '-' };
        }

        const values = timeSlot.ElementValue[0];

        if (el.ElementName === '天氣現象') dailyData[date].wx = values.Weather || dailyData[date].wx;
        else if (el.ElementName === '最低溫度') dailyData[date].minT = values.MinTemperature || dailyData[date].minT;
        else if (el.ElementName === '最高溫度') dailyData[date].maxT = values.MaxTemperature || dailyData[date].maxT;
        else if (el.ElementName === '12小時降雨機率') dailyData[date].pop = values.ProbabilityOfPrecipitation || dailyData[date].pop;
        else if (el.ElementName === '紫外線指數') dailyData[date].uvi = values.UVIndex || dailyData[date].uvi;
      }
    }

    // 排序日期（最多7天）
    const sortedDates = Object.keys(dailyData).sort().slice(0, 7);
    if (sortedDates.length === 0) return null;

    // 格式化輸出
    let result = `🌤️ 桃園中壢一週天氣預報\n\n`;

    // 今天詳細版
    const todayData = dailyData[sortedDates[0]];
    const todayDate = new Date(sortedDates[0]);
    const todayStr = todayDate.toLocaleDateString('zh-TW', {
      timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'long'
    });
    const todayIcon = getWeatherIcon(todayData.wx);

    result += `【今天】${todayStr}\n`;
    result += `${todayIcon} ${todayData.wx}\n`;
    result += `🌡️ ${todayData.minT}~${todayData.maxT}°C\n`;
    result += `☔ 降雨${todayData.pop}% | ☀️ UV${todayData.uvi}\n\n`;

    // 未來6天簡潔版
    result += `【未來6天】\n`;
    for (let i = 1; i < sortedDates.length; i++) {
      const date = sortedDates[i];
      const dayData = dailyData[date];
      const dayDate = new Date(date);
      const month = dayDate.getMonth() + 1;
      const day = dayDate.getDate();
      const weekday = ['日', '一', '二', '三', '四', '五', '六'][dayDate.getDay()];
      const icon = getWeatherIcon(dayData.wx);

      result += `${month}/${day}(${weekday}) ${icon} ${dayData.wx} ${dayData.minT}~${dayData.maxT}°C\n`;
    }

    result += `\n資料來源：中央氣象署`;
    return result;
  } catch (e) {
    console.error('[天氣] 一週預報取得失敗：', e.message);
    return null;
  }
}

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

  // 訂閱每日天氣/氣象
  if (/訂閱(天氣|氣象)|每日(天氣|氣象)|(天氣|氣象)通知|開啟(天氣|氣象)|桃園(天氣|氣象)|中壢(天氣|氣象)/.test(text)) {
    const subs = db.get('weatherSubscribers').value();
    if (!subs.includes(userId)) {
      db.get('weatherSubscribers').push(userId).write();
    }
    // 立即發送一週天氣預覽
    const weather = await fetchZhongliWeatherWeekly();
    const preview = weather ? `\n\n📋 一週天氣預覽：\n${weather}` : '\n\n（請確認已設定 CWA_API_KEY 環境變數）';
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `✅ 已訂閱每日天氣通知！\n每天早上 6:00 會自動推播桃園中壢一週天氣預報 🌤️${preview}` }]
    });
  }

  // 取消天氣/氣象訂閱
  if (/取消(天氣|氣象)|停止(天氣|氣象)|關閉(天氣|氣象)/.test(text)) {
    db.get('weatherSubscribers').remove(id => id === userId).write();
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: '✅ 已取消每日天氣通知' }]
    });
  }

  // 查詢一週天氣/氣象（即時）
  if (/(^(天氣|氣象)$|今天(天氣|氣象)|現在(天氣|氣象)|查(天氣|氣象)|(天氣|氣象)如何|(天氣|氣象)怎麼樣)/.test(text)) {
    const weather = await fetchZhongliWeatherWeekly();
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: weather || '❌ 天氣資料取得失敗，請稍後再試' }]
    });
  }

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

  if (groq) {
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

async function saveReminder(userId, content, eventAt, replyToken) {
  const now = new Date();
  const groupId = db.get('nextId').value();
  let nextId = groupId;

  // 計算當天早上 8:00（台灣時間）
  const eventDateStr = eventAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); // YYYY-MM-DD
  const morningRemind = new Date(eventDateStr + 'T08:00:00+08:00');

  // 事件前 1 小時
  const preRemind = new Date(eventAt.getTime() - 60 * 60 * 1000);

  const addedReminders = [];

  // 早上 8 點提醒（僅未來時間）
  if (morningRemind > now) {
    db.get('reminders').push({
      id: nextId, groupId, userId,
      message: content,
      eventAt: eventAt.getTime(),
      remindAt: morningRemind.getTime(),
      type: 'morning',
      sent: false
    }).write();
    addedReminders.push({ time: morningRemind, label: '🌅 當天早上8點' });
    nextId++;
  }

  // 事件前 1 小時提醒（僅未來時間，且與早上8點至少差10分鐘）
  if (preRemind > now && Math.abs(preRemind.getTime() - morningRemind.getTime()) > 10 * 60000) {
    db.get('reminders').push({
      id: nextId, groupId, userId,
      message: content,
      eventAt: eventAt.getTime(),
      remindAt: preRemind.getTime(),
      type: 'pre',
      sent: false
    }).write();
    addedReminders.push({ time: preRemind, label: '⏰ 事件前1小時' });
    nextId++;
  }

  db.set('nextId', nextId).write();

  // 加入 Google 日曆
  const hasGoogle = db.get('googleTokens').get(userId).value();
  let calendarMsg = '';
  if (hasGoogle) {
    const added = await addToGoogleCalendar(userId, content, eventAt);
    calendarMsg = added ? '\n📅 已同步加入 Google 日曆' : '';
  }

  const reminderLines = addedReminders.length > 0
    ? addedReminders.map(r => `${r.label}：${formatTime(r.time)}`).join('\n')
    : '（時間太近，無法設定提醒）';

  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: `✅ 提醒已設定！\n\n📌 ${content}\n📅 事件時間：${formatTime(eventAt)}\n\n提醒時間：\n${reminderLines}\n\n編號 #${groupId}${calendarMsg}`
    }]
  });
}

async function sendReminderList(userId, replyToken) {
  const now = Date.now();
  const reminders = db.get('reminders')
    .filter(r => r.userId === userId && !r.sent && r.remindAt > now)
    .sortBy('remindAt').value();

  // 依 groupId 分組顯示
  const groups = {};
  for (const r of reminders) {
    const key = r.groupId !== undefined ? r.groupId : r.id;
    if (!groups[key]) groups[key] = { id: key, message: r.message, eventAt: r.eventAt || r.remindAt, times: [] };
    groups[key].times.push({ type: r.type, time: r.remindAt });
  }

  const groupList = Object.values(groups).sort((a, b) => a.eventAt - b.eventAt).slice(0, 10);

  const hasGoogle = db.get('googleTokens').get(userId).value();
  const googleStatus = hasGoogle ? '📅 Google 日曆：已連結' : '📅 Google 日曆：未連結（傳送「綁定Google日曆」來連結）';

  const msg = groupList.length === 0
    ? `📋 目前沒有待提醒的事項\n\n${googleStatus}`
    : `📋 您的提醒列表：\n\n${groupList.map(g => {
        const timeLines = g.times.map(t => {
          const label = t.type === 'morning' ? '🌅 早8點' : t.type === 'pre' ? '⏰ 前1小時' : '⏰';
          return `  ${label}：${formatTime(new Date(t.time))}`;
        }).join('\n');
        return `#${g.id} 📌 ${g.message}\n📅 ${formatTime(new Date(g.eventAt))}\n${timeLines}`;
      }).join('\n\n')}\n\n輸入「刪除 編號」可刪除\n\n${googleStatus}`;

  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: msg }]
  });
}

async function deleteReminder(userId, groupId, replyToken) {
  const before = db.get('reminders').size().value();
  // 刪除同一組的所有提醒（早上8點 + 事前1小時）
  db.get('reminders').remove(r => r.userId === userId && (r.groupId === groupId || r.id === groupId)).write();
  const after = db.get('reminders').size().value();

  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: before > after ? `✅ 已刪除提醒 #${groupId}（共刪除 ${before - after} 筆）` : `❌ 找不到提醒 #${groupId}`
    }]
  });
}

async function sendHelp(replyToken) {
  await client.replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: '你好！我是提醒小秘書 📋\n\n📝 設定提醒範例：\n「明天下午3點開會」\n「幫我記得後天交報告」\n「一小時後提醒我喝水」\n「下週一早上9點看醫生」\n「提醒我今晚8點追劇」\n\n📋 查看提醒：「提醒列表」\n🗑️ 刪除提醒：「刪除 1」\n📅 連結Google日曆：「綁定Google日曆」\n🌤️ 每日天氣：「訂閱天氣」\n🌤️ 取消天氣：「取消天氣」'
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
      const eventTimeStr = reminder.eventAt
        ? `\n📅 事件時間：${formatTime(new Date(reminder.eventAt))}`
        : '';
      const displayId = reminder.groupId !== undefined ? reminder.groupId : reminder.id;

      let text;
      if (reminder.type === 'morning') {
        text = `🌅 今日事項提醒！\n\n📌 ${reminder.message}${eventTimeStr}\n\n(編號 #${displayId})`;
      } else if (reminder.type === 'pre') {
        text = `⏰ 1小時後即將開始！\n\n📌 ${reminder.message}${eventTimeStr}\n\n(編號 #${displayId})`;
      } else {
        // 舊版相容
        text = `⏰ 提醒時間到！\n\n📌 ${reminder.message}\n\n(提醒 #${reminder.id})`;
      }

      await client.pushMessage({
        to: reminder.userId,
        messages: [{ type: 'text', text }]
      });
      db.get('reminders').find({ id: reminder.id }).assign({ sent: true }).write();
    } catch (e) {
      console.error('推播失敗：', e.message);
    }
  }
});

// 每天早上 6:00 台灣時間推播一週天氣預報（UTC 22:00 = 台灣 06:00）
cron.schedule('0 22 * * *', async () => {
  const subscribers = db.get('weatherSubscribers').value();
  if (subscribers.length === 0) return;

  console.log(`[天氣] 開始推播一週天氣給 ${subscribers.length} 位訂閱者`);
  const weather = await fetchZhongliWeatherWeekly();
  if (!weather) {
    console.error('[天氣] 一週天氣取得失敗，跳過推播');
    return;
  }

  for (const userId of subscribers) {
    try {
      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: weather }]
      });
    } catch (e) {
      console.error(`[天氣] 推播失敗 (${userId})：`, e.message);
    }
  }
});

app.get('/', (req, res) => res.send('LINE Bot Secretary is running! 🤖'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
