require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const Groq = require('groq-sdk');
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');
const https = require('https');

// ─── MongoDB 連線 ────────────────────────────────────────────
let _db = null;

async function getDB() {
  if (_db) return _db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI 未設定');
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 15000,
  });
  await client.connect();
  _db = client.db('linebot');
  // 初始化 nextId
  await _db.collection('settings').updateOne(
    { key: 'nextId' },
    { $setOnInsert: { key: 'nextId', value: 1 } },
    { upsert: true }
  );
  console.log('[DB] MongoDB 連線成功');
  return _db;
}

// ─── DB 工具函數 ─────────────────────────────────────────────
async function getNextId() {
  const db = await getDB();
  const result = await db.collection('settings').findOneAndUpdate(
    { key: 'nextId' },
    { $inc: { value: 1 } },
    { returnDocument: 'after', upsert: true }
  );
  return result.value;
}

async function dbAddReminder(reminder) {
  const db = await getDB();
  await db.collection('reminders').insertOne(reminder);
}

async function dbGetDueReminders() {
  const db = await getDB();
  return db.collection('reminders')
    .find({ sent: false, remindAt: { $lte: Date.now() } })
    .toArray();
}

async function dbMarkSent(id) {
  const db = await getDB();
  await db.collection('reminders').updateOne({ id }, { $set: { sent: true } });
}

async function dbGetUserReminders(userId) {
  const db = await getDB();
  return db.collection('reminders')
    .find({ userId, sent: false, remindAt: { $gt: Date.now() } })
    .sort({ remindAt: 1 })
    .limit(10)
    .toArray();
}

async function dbDeleteRemindersByGroup(userId, groupId) {
  const db = await getDB();
  const result = await db.collection('reminders').deleteMany({
    userId,
    $or: [{ groupId }, { id: groupId }]
  });
  return result.deletedCount;
}

async function dbCountReminders() {
  const db = await getDB();
  return db.collection('reminders').countDocuments();
}

async function dbGetGoogleTokens(userId) {
  const db = await getDB();
  const doc = await db.collection('googleTokens').findOne({ userId });
  if (!doc) return null;
  const { _id, userId: _uid, ...tokens } = doc;
  return tokens;
}

async function dbSaveGoogleTokens(userId, tokens) {
  const db = await getDB();
  await db.collection('googleTokens').updateOne(
    { userId },
    { $set: { userId, ...tokens } },
    { upsert: true }
  );
}

async function dbGetWeatherSubscribers() {
  const db = await getDB();
  const docs = await db.collection('weatherSubscribers').find({}).toArray();
  return docs.map(d => d.userId);
}

async function dbAddWeatherSubscriber(userId) {
  const db = await getDB();
  await db.collection('weatherSubscribers').updateOne(
    { userId },
    { $set: { userId } },
    { upsert: true }
  );
}

async function dbRemoveWeatherSubscriber(userId) {
  const db = await getDB();
  await db.collection('weatherSubscribers').deleteOne({ userId });
}

// ─── 應用程式初始化 ──────────────────────────────────────────
const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.messagingApi.MessagingApiClient(lineConfig);

const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

// ─── HTTP GET 工具 ───────────────────────────────────────────
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

// ─── 天氣工具 ────────────────────────────────────────────────
function getWeatherIcon(weather) {
  if (!weather) return '🌤️';
  return weather.includes('雷') ? '⛈️' : weather.includes('雨') ? '🌧️' :
         weather.includes('陰') ? '☁️' : weather.includes('多雲') ? '⛅' : '☀️';
}

// 取得訂閱者（DB + 環境變數備援）
async function getWeatherSubscribers() {
  const dbSubs = await dbGetWeatherSubscribers().catch(() => []);
  const envSubs = process.env.WEATHER_SUBSCRIBERS
    ? process.env.WEATHER_SUBSCRIBERS.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  return [...new Set([...dbSubs, ...envSubs])];
}

// 取得桃園中壢一週天氣預報
async function fetchZhongliWeatherWeekly() {
  const apiKey = process.env.CWA_API_KEY;
  if (!apiKey) { console.error('[天氣] CWA_API_KEY 未設置'); return null; }

  try {
    const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/F-D0047-007?Authorization=${apiKey}&locationName=%E4%B8%AD%E5%A3%A2%E5%8D%80&elementName=Wx,MinT,MaxT,PoP12h,UVI`;
    const data = await httpsGet(url);
    const locations = data.records?.Locations?.[0]?.Location || [];
    const location = locations.find(loc => loc.LocationName === '中壢區');
    if (!location) { console.error('[天氣] 找不到中壢區的數據'); return null; }

    const dailyData = {};
    for (const el of location.WeatherElement || []) {
      if (!el.Time) continue;
      for (const timeSlot of el.Time) {
        if (!timeSlot.StartTime || !timeSlot.ElementValue?.[0]) continue;
        const date = timeSlot.StartTime.substring(0, 10);
        if (!dailyData[date]) dailyData[date] = { wx: '無資料', minT: '-', maxT: '-', pop: '-', uvi: '-' };
        const values = timeSlot.ElementValue[0];
        if (el.ElementName === '天氣現象') dailyData[date].wx = values.Weather || dailyData[date].wx;
        else if (el.ElementName === '最低溫度') dailyData[date].minT = values.MinTemperature || dailyData[date].minT;
        else if (el.ElementName === '最高溫度') dailyData[date].maxT = values.MaxTemperature || dailyData[date].maxT;
        else if (el.ElementName === '12小時降雨機率') dailyData[date].pop = values.ProbabilityOfPrecipitation || dailyData[date].pop;
        else if (el.ElementName === '紫外線指數') dailyData[date].uvi = values.UVIndex || dailyData[date].uvi;
      }
    }

    const sortedDates = Object.keys(dailyData).sort().slice(0, 7);
    if (sortedDates.length === 0) return null;

    let result = `🌤️ 中壢區一週天氣預報\n📍 地點：中壢區\n\n`;
    const todayData = dailyData[sortedDates[0]];
    const todayStr = new Date(sortedDates[0]).toLocaleDateString('zh-TW', {
      timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'long'
    });
    result += `【今天】${todayStr}\n${getWeatherIcon(todayData.wx)} ${todayData.wx}\n`;
    result += `🌡️ 氣溫：${todayData.minT}~${todayData.maxT}°C\n`;
    result += `☔ 降雨機率：${todayData.pop}%\n☀️ 紫外線：${todayData.uvi}\n\n`;
    result += `【未來6天降雨機率】\n`;
    for (let i = 1; i < sortedDates.length; i++) {
      const date = sortedDates[i];
      const d = dailyData[date];
      const dayDate = new Date(date);
      const weekday = ['日', '一', '二', '三', '四', '五', '六'][dayDate.getDay()];
      result += `${dayDate.getMonth()+1}/${dayDate.getDate()}(${weekday}) ${getWeatherIcon(d.wx)} ${d.wx} ${d.minT}~${d.maxT}°C ☔${d.pop}%\n`;
    }
    result += `\n資料來源：中央氣象署`;
    return result;
  } catch (e) {
    console.error('[天氣] 一週預報取得失敗：', e.message);
    return null;
  }
}

// ─── Google OAuth2 ───────────────────────────────────────────
function getOAuth2Client(redirectUri) {
  const finalRedirectUri = process.env.GOOGLE_REDIRECT_URI || redirectUri || `https://line-bot-secretary.onrender.com/oauth/google/callback`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    finalRedirectUri
  );
}

app.get('/oauth/google', (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).send('Missing userId');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const redirectUri = `${protocol}://${host}/oauth/google/callback`;
  const oauth2Client = getOAuth2Client(redirectUri);
  const googleUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', scope: ['https://www.googleapis.com/auth/calendar'],
    state: userId, prompt: 'consent'
  });
  res.send(`<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>授權 Google 日曆</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px 20px;background:#f5f5f5}
.card{background:white;border-radius:16px;padding:32px 24px;max-width:400px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,.1)}
h2{color:#333;margin-bottom:8px}p{color:#666;font-size:14px;line-height:1.6}
.btn{display:block;background:#4285F4;color:white;text-decoration:none;padding:14px 24px;border-radius:8px;font-size:16px;font-weight:bold;margin:24px auto}
.warning{background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px;font-size:13px;color:#856404;margin-top:16px}
.url-box{background:#f0f0f0;border-radius:8px;padding:10px;font-size:11px;word-break:break-all;color:#555;margin-top:16px;text-align:left}</style></head>
<body><div class="card"><h2>📅 授權 Google 日曆</h2>
<p>請點下方按鈕，在外部瀏覽器（Chrome / Safari）中完成 Google 授權</p>
<a class="btn" href="${googleUrl}" target="_blank" rel="noopener">點此開啟 Google 授權</a>
<div class="warning">⚠️ 若點擊後仍在 LINE 瀏覽器內，請長按按鈕選擇「以瀏覽器開啟」</div>
<div class="url-box">或複製此網址到 Chrome / Safari 開啟：<br><br>${googleUrl}</div>
</div></body></html>`);
});

app.get('/oauth/google/callback', async (req, res) => {
  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or userId');
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const redirectUri = `${protocol}://${host}/oauth/google/callback`;
    const oauth2Client = getOAuth2Client(redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const calApi = google.calendar({ version: 'v3', auth: oauth2Client });
    const calList = await calApi.calendarList.list();
    const TARGET_CAL = '柏程行事曆';
    let calendarId = 'primary';
    const found = (calList.data.items || []).find(c => c.summary === TARGET_CAL);
    if (found) { calendarId = found.id; console.log(`[Google OAuth] 找到「${TARGET_CAL}」ID:`, calendarId); }

    await dbSaveGoogleTokens(userId, { ...tokens, calendarId });

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px">
      <h2>✅ Google 日曆綁定成功！</h2>
      <p>您的 LINE 提醒小秘書現在會自動把提醒加入「${found ? TARGET_CAL : '主要行事曆'}」</p>
      <p>可以關閉此視窗了</p></body></html>`);
    await client.pushMessage({
      to: userId,
      messages: [{ type: 'text', text: `✅ Google 日曆綁定成功！\n\n以後設定提醒時，我也會自動幫您加入「${found ? TARGET_CAL : '主要行事曆'}」📅` }]
    });
  } catch (e) {
    console.error('Google OAuth callback error:', e.message);
    res.status(500).send('授權失敗，請重試');
  }
});

async function addToGoogleCalendar(userId, summary, startTime) {
  const tokens = await dbGetGoogleTokens(userId);
  if (!tokens) return false;
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);
    oauth2Client.on('tokens', async (newTokens) => {
      await dbSaveGoogleTokens(userId, { ...tokens, ...newTokens });
    });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const endTime = new Date(startTime.getTime() + 30 * 60000);
    const calendarId = tokens.calendarId || 'primary';
    await calendar.events.insert({
      calendarId,
      resource: {
        summary,
        start: { dateTime: startTime.toISOString(), timeZone: 'Asia/Taipei' },
        end: { dateTime: endTime.toISOString(), timeZone: 'Asia/Taipei' },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }
      }
    });
    return true;
  } catch (e) {
    console.error('Google Calendar 新增失敗：', e.message);
    return false;
  }
}

// ─── Webhook ─────────────────────────────────────────────────
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
    await dbAddWeatherSubscriber(userId);
    console.log(`[天氣] 新訂閱者: ${userId}`);
    const weather = await fetchZhongliWeatherWeekly();
    const preview = weather ? `\n\n📋 一週天氣預覽：\n${weather}` : '\n\n（請確認已設定 CWA_API_KEY 環境變數）';
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `✅ 已訂閱每日天氣通知！\n每天早上 6:00 會自動推播桃園中壢一週天氣預報 🌤️${preview}` }]
    });
  }

  // 取消天氣/氣象訂閱
  if (/取消(天氣|氣象)|停止(天氣|氣象)|關閉(天氣|氣象)/.test(text)) {
    await dbRemoveWeatherSubscriber(userId);
    return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '✅ 已取消每日天氣通知' }] });
  }

  // 查詢一週天氣/氣象（即時）
  if (/(^(天氣|氣象)$|今天(天氣|氣象)|現在(天氣|氣象)|查(天氣|氣象)|(天氣|氣象)如何|(天氣|氣象)怎麼樣)/.test(text)) {
    const weather = await fetchZhongliWeatherWeekly();
    return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: weather || '❌ 天氣資料取得失敗，請稍後再試' }] });
  }

  // 查詢自己的 LINE userId
  if (/我的id|我的ID|myid|userid|我的用戶id/i.test(text)) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `🆔 你的 LINE User ID：\n\n${userId}\n\n請複製此 ID 並到 Render 環境變數設定 WEATHER_SUBSCRIBERS` }]
    });
  }

  // 綁定 Google 日曆
  if (/綁定.*google|連結.*google|google.*日曆|授權.*日曆|link.*google/i.test(text)) {
    const baseUrl = process.env.BOT_BASE_URL || `https://line-bot-secretary.onrender.com`;
    const authUrl = `${baseUrl}/oauth/google?userId=${userId}`;
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `📅 請點以下連結授權 Google 日曆：\n\n${authUrl}\n\n授權後，每次設定提醒都會自動加入您的 Google 日曆！` }]
    });
  }

  let parsed = null;
  if (groq) {
    try { parsed = await parseWithGroq(text); }
    catch (e) { console.error('Groq 解析失敗，改用關鍵字：', e.message); }
  }
  if (!parsed) parsed = parseByKeyword(text);
  if (!parsed) return sendHelp(event.replyToken);

  switch (parsed.intent) {
    case 'list_reminders': return sendReminderList(userId, event.replyToken);
    case 'delete_reminder': return deleteReminder(userId, parsed.deleteId, event.replyToken);
    case 'set_reminder':
      if (parsed.datetime && parsed.datetime > new Date()) {
        return saveReminder(userId, parsed.content, parsed.datetime, event.replyToken);
      }
      return client.replyMessage({ replyToken: event.replyToken, messages: [{ type: 'text', text: '❓ 我沒辦法辨識提醒時間，請試著說「明天下午3點 開會」' }] });
    default: return sendHelp(event.replyToken);
  }
}

async function parseWithGroq(text) {
  const nowStr = new Date().toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long'
  });
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: `你是LINE提醒機器人的語意解析器。現在台灣時間：${nowStr}\n回傳純JSON（不要markdown代碼塊）：\n{"intent":"set_reminder|list_reminders|delete_reminder|unknown","content":"提醒內容（去掉時間詞和觸發詞）","datetime":"ISO8601台灣時間或null","deleteId":數字或null}\n規則：1.含提醒我/幫我記得/別忘了/X點/明天/後天/下週/小時後→set_reminder 2.含提醒列表/查看提醒→list_reminders 3.含刪除/取消+數字→delete_reminder 4.其他→unknown 5.datetime必須是未來時間 6.只有時段沒有具體時間：早上預設09:00，下午預設14:00，晚上預設20:00` },
      { role: 'user', content: text }
    ],
    temperature: 0.1, max_tokens: 200
  });
  const raw = completion.choices[0].message.content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const data = JSON.parse(raw);
  return { intent: data.intent, content: data.content || text, datetime: data.datetime ? new Date(data.datetime) : null, deleteId: data.deleteId || null };
}

function parseByKeyword(text) {
  const now = new Date();
  if (/提醒列表|查看提醒|我的提醒|列出提醒|有什麼提醒|所有提醒/.test(text)) return { intent: 'list_reminders' };
  const delMatch = text.match(/[刪取移][除消掉]\s*[#＃]?(\d+)/);
  if (delMatch) return { intent: 'delete_reminder', deleteId: parseInt(delMatch[1]) };
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
  const groupId = await getNextId();
  const eventDateStr = eventAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const morningRemind = new Date(eventDateStr + 'T08:00:00+08:00');
  const preRemind = new Date(eventAt.getTime() - 60 * 60 * 1000);
  const addedReminders = [];

  if (morningRemind > now) {
    await dbAddReminder({ id: groupId, groupId, userId, message: content, eventAt: eventAt.getTime(), remindAt: morningRemind.getTime(), type: 'morning', sent: false });
    addedReminders.push({ time: morningRemind, label: '🌅 當天早上8點' });
  }

  if (preRemind > now && Math.abs(preRemind.getTime() - morningRemind.getTime()) > 10 * 60000) {
    const preId = await getNextId();
    await dbAddReminder({ id: preId, groupId, userId, message: content, eventAt: eventAt.getTime(), remindAt: preRemind.getTime(), type: 'pre', sent: false });
    addedReminders.push({ time: preRemind, label: '⏰ 事件前1小時' });
  }

  const tokens = await dbGetGoogleTokens(userId);
  let calendarMsg = '';
  if (tokens) {
    const added = await addToGoogleCalendar(userId, content, eventAt);
    calendarMsg = added ? '\n📅 已同步加入 Google 日曆' : '';
  }

  const reminderLines = addedReminders.length > 0
    ? addedReminders.map(r => `${r.label}：${formatTime(r.time)}`).join('\n')
    : '（時間太近，無法設定提醒）';

  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: `✅ 提醒已設定！\n\n📌 ${content}\n📅 事件時間：${formatTime(eventAt)}\n\n提醒時間：\n${reminderLines}\n\n編號 #${groupId}${calendarMsg}` }]
  });
}

async function sendReminderList(userId, replyToken) {
  const reminders = await dbGetUserReminders(userId);
  const groups = {};
  for (const r of reminders) {
    const key = r.groupId !== undefined ? r.groupId : r.id;
    if (!groups[key]) groups[key] = { id: key, message: r.message, eventAt: r.eventAt || r.remindAt, times: [] };
    groups[key].times.push({ type: r.type, time: r.remindAt });
  }
  const groupList = Object.values(groups).sort((a, b) => a.eventAt - b.eventAt).slice(0, 10);
  const tokens = await dbGetGoogleTokens(userId);
  const googleStatus = tokens ? '📅 Google 日曆：已連結' : '📅 Google 日曆：未連結（傳送「綁定Google日曆」來連結）';
  const msg = groupList.length === 0
    ? `📋 目前沒有待提醒的事項\n\n${googleStatus}`
    : `📋 您的提醒列表：\n\n${groupList.map(g => {
        const timeLines = g.times.map(t => {
          const label = t.type === 'morning' ? '🌅 早8點' : t.type === 'pre' ? '⏰ 前1小時' : '⏰';
          return `  ${label}：${formatTime(new Date(t.time))}`;
        }).join('\n');
        return `#${g.id} 📌 ${g.message}\n📅 ${formatTime(new Date(g.eventAt))}\n${timeLines}`;
      }).join('\n\n')}\n\n輸入「刪除 編號」可刪除\n\n${googleStatus}`;
  await client.replyMessage({ replyToken, messages: [{ type: 'text', text: msg }] });
}

async function deleteReminder(userId, groupId, replyToken) {
  const deleted = await dbDeleteRemindersByGroup(userId, groupId);
  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: deleted > 0 ? `✅ 已刪除提醒 #${groupId}（共刪除 ${deleted} 筆）` : `❌ 找不到提醒 #${groupId}` }]
  });
}

async function sendHelp(replyToken) {
  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text: '你好！我是提醒小秘書 📋\n\n📝 設定提醒範例：\n「明天下午3點開會」\n「幫我記得後天交報告」\n「一小時後提醒我喝水」\n「下週一早上9點看醫生」\n「提醒我今晚8點追劇」\n\n📋 查看提醒：「提醒列表」\n🗑️ 刪除提醒：「刪除 1」\n📅 連結Google日曆：「綁定Google日曆」\n🌤️ 每日天氣：「訂閱天氣」\n🌤️ 取消天氣：「取消天氣」' }]
  });
}

function formatTime(date) {
  return date.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  });
}

// ─── Cron：每分鐘檢查到期提醒 ────────────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const due = await dbGetDueReminders();
    for (const reminder of due) {
      try {
        const eventTimeStr = reminder.eventAt ? `\n📅 事件時間：${formatTime(new Date(reminder.eventAt))}` : '';
        const displayId = reminder.groupId !== undefined ? reminder.groupId : reminder.id;
        let text;
        if (reminder.type === 'morning') text = `🌅 今日事項提醒！\n\n📌 ${reminder.message}${eventTimeStr}\n\n(編號 #${displayId})`;
        else if (reminder.type === 'pre') text = `⏰ 1小時後即將開始！\n\n📌 ${reminder.message}${eventTimeStr}\n\n(編號 #${displayId})`;
        else text = `⏰ 提醒時間到！\n\n📌 ${reminder.message}\n\n(提醒 #${reminder.id})`;
        await client.pushMessage({ to: reminder.userId, messages: [{ type: 'text', text }] });
        await dbMarkSent(reminder.id);
      } catch (e) { console.error('推播失敗：', e.message); }
    }
  } catch (e) { console.error('[Cron] 提醒檢查失敗：', e.message); }
});

// ─── 天氣推播 ────────────────────────────────────────────────
async function pushWeatherToSubscribers() {
  const subscribers = await getWeatherSubscribers();
  if (subscribers.length === 0) { console.log('[天氣] 無訂閱者，跳過推播'); return { ok: 0, total: 0 }; }
  console.log(`[天氣] 開始推播一週天氣給 ${subscribers.length} 位訂閱者`);
  const weather = await fetchZhongliWeatherWeekly();
  if (!weather) { console.error('[天氣] 天氣取得失敗'); return { ok: 0, total: subscribers.length, error: 'weather_fetch_failed' }; }
  let ok = 0;
  for (const uid of subscribers) {
    try {
      await client.pushMessage({ to: uid, messages: [{ type: 'text', text: weather }] });
      ok++;
    } catch (e) {
      console.error(`[天氣] 推播失敗 (${uid})：`, e.message);
      if (e.statusCode === 400 || e.statusCode === 403) {
        await dbRemoveWeatherSubscriber(uid);
        console.log(`[天氣] 已自動移除封鎖訂閱者: ${uid}`);
      }
    }
  }
  return { ok, total: subscribers.length };
}

// 天氣推播改由 GitHub Actions 外部觸發 /cron/weather，不使用內部 cron 避免重複推播

// ─── HTTP 端點 ───────────────────────────────────────────────
app.get('/', (req, res) => res.send('LINE Bot Secretary is running! 🤖'));

app.get('/cron/weather', async (req, res) => {
  if (req.query.secret !== (process.env.CRON_SECRET || 'weather2024')) return res.status(401).send('Unauthorized');
  const result = await pushWeatherToSubscribers();
  if (result.error) return res.status(500).send(`天氣取得失敗：${result.error}`);
  res.send(`✅ 天氣推播完成，成功 ${result.ok}/${result.total}`);
});

// ─── 啟動 ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await getDB(); // 先確認 MongoDB 連線
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (e) {
    console.error('❌ 啟動失敗（MongoDB 連線錯誤）：', e.message);
    process.exit(1);
  }
}

start();
