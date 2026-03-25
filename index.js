require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const cron = require('node-cron');
const chrono = require('chrono-node');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

// Trigger redeploy with environment variables update 2026-03-26

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

  if (text === '提醒列表' || text === '查看提醒') {
    return sendReminderList(userId);
  }

  if (text.startsWith('刪除 ')) {
    const id = parseInt(text.replace('刪除 ', ''));
    return deleteReminder(userId, id);
  }

  const results = chrono.zh.parse(text, new Date());

  if (results.length > 0) {
    const remindAt = results[0].date();
    if (remindAt > new Date()) {
      const content = text.replace(results[0].text, '').trim() || text;
      const id = db.get('nextId').value();
      db.get('reminders').push({
        id, userId,
        message: content,
        remindAt: remindAt.getTime(),
        sent: false
      }).write();
      db.set('nextId', id + 1).write();

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: 'text',
          text: `✅ 已設定提醒！\n\n📌 ${content}\n⏰ ${formatTime(remindAt)}\n\n(編號 #${id})`
        }]
      });
      return;
    }
  }

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{
      type: 'text',
      text: '你好！我是提醒小秘書 📋\n\n設定提醒請說：\n「明天下午3點 開會」\n「下週一早上9點 繳報告」\n\n其他指令：\n• 提醒列表\n• 刪除 編號'
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