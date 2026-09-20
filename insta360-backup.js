const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

let _db = null;

async function getDB() {
  if (_db) return _db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI 未設定');
  const client = new MongoClient(uri);
  await client.connect();
  _db = client.db('linebot');
  return _db;
}

// 初始化備份紀錄表
async function initBackupCollection() {
  const db = await getDB();
  const collection = db.collection('insta360_backups');
  await collection.createIndex({ fileId: 1, backupDate: 1 }, { unique: true }).catch(() => {});
  await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 604800 }).catch(() => {});
  return collection;
}

// 保存備份紀錄
async function saveBackupRecord(fileId, fileName, googleFileId, backupDate) {
  const collection = await initBackupCollection();
  await collection.updateOne(
    { fileId, backupDate },
    {
      $set: {
        fileName,
        googleFileId,
        backupDate,
        createdAt: new Date(),
        status: 'backed_up'
      }
    },
    { upsert: true }
  );
}

// 查詢 7 天前的備份
async function getOldBackups(daysOld = 7) {
  const collection = await initBackupCollection();
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  return collection.find({
    status: 'backed_up',
    createdAt: { $lt: cutoffDate }
  }).toArray();
}

// INSTA360 登入
async function login360(browser, email, password) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  console.log('[INSTA360] 正在登入...');
  await page.goto('https://cloud.insta360.com/login', { waitUntil: 'networkidle2' });

  // 填入郵箱
  await page.type('input[name="email"], input[placeholder*="email" i]', email, { delay: 50 });
  await page.waitForTimeout(500);

  // 填入密碼
  await page.type('input[name="password"], input[type="password"]', password, { delay: 50 });
  await page.waitForTimeout(500);

  // 點擊登入按鈕
  await page.click('button[type="submit"], button:has-text("Sign In"), button:has-text("登入")');

  // 等待登入完成（可能有驗證碼）
  try {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    console.log('[INSTA360] ✅ 登入成功');
  } catch (e) {
    console.warn('[INSTA360] ⚠️ 登入可能需要驗證，檢查驗證碼...');
  }

  return page;
}

// 獲取相簾文件列表
async function fetchAlbumFiles(page) {
  console.log('[INSTA360] 正在獲取相簾列表...');

  await page.goto('https://cloud.insta360.com/album', { waitUntil: 'networkidle2' }).catch(() => {});

  // 等待相簾載入
  await page.waitForTimeout(3000);

  // 使用 API 直接獲取檔案列表（通常比 DOM 解析更可靠）
  const files = await page.evaluate(async () => {
    const response = await fetch('/api/album/files', {
      headers: { 'Content-Type': 'application/json' }
    }).catch(() => null);
    if (!response || !response.ok) return [];
    const data = await response.json();
    return data.files || data.data || [];
  }).catch(() => []);

  if (files.length > 0) {
    console.log(`[INSTA360] 找到 ${files.length} 個文件`);
    return files;
  }

  // 降級方案：從 DOM 解析
  console.log('[INSTA360] 使用 DOM 解析相簾文件...');
  const domFiles = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('[data-file-id], [class*="item"], [class*="file"]').forEach(el => {
      const fileId = el.dataset.fileId || el.getAttribute('data-id');
      const fileName = el.querySelector('[class*="title"], [class*="name"]')?.textContent || 'Unknown';
      const url = el.querySelector('img')?.src || el.querySelector('video')?.src || '';
      if (fileId || url) {
        items.push({ fileId: fileId || url, fileName: fileName.trim(), url });
      }
    });
    return items;
  });

  console.log(`[INSTA360] DOM 解析找到 ${domFiles.length} 個文件`);
  return domFiles;
}

// 下載檔案
async function downloadFile(page, fileUrl, fileName, outputPath) {
  try {
    console.log(`[INSTA360] 正在下載: ${fileName}`);

    const response = await axios.get(fileUrl, {
      responseType: 'stream',
      timeout: 300000, // 5分鐘超時
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`[INSTA360] ✅ 下載完成: ${fileName}`);
        resolve(true);
      });
      writer.on('error', reject);
    });
  } catch (e) {
    console.error(`[INSTA360] ❌ 下載失敗 ${fileName}: ${e.message}`);
    return false;
  }
}

// 上傳到 Google Drive
async function uploadToGoogleDrive(google, auth, filePath, fileName, parentFolderId) {
  try {
    const drive = google.drive({ version: 'v3', auth });
    const fileStats = fs.statSync(filePath);
    const fileSize = fileStats.size;

    console.log(`[Google Drive] 正在上傳: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`);

    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [parentFolderId],
        mimeType: 'application/octet-stream'
      },
      media: {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(filePath)
      },
      supportsAllDrives: true
    });

    console.log(`[Google Drive] ✅ 上傳成功: ${fileName} (ID: ${response.data.id})`);
    return response.data.id;
  } catch (e) {
    console.error(`[Google Drive] ❌ 上傳失敗 ${fileName}: ${e.message}`);
    return null;
  }
}

// 在 Google Drive 中創建日期資料夾
async function getOrCreateDateFolder(google, auth, parentFolderId, dateFolder) {
  try {
    const drive = google.drive({ version: 'v3', auth });

    // 查詢是否已存在該日期資料夾
    const response = await drive.files.list({
      q: `name='${dateFolder}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`,
      spaces: 'drive',
      pageSize: 1,
      supportsAllDrives: true
    });

    if (response.data.files && response.data.files.length > 0) {
      return response.data.files[0].id;
    }

    // 不存在則創建
    console.log(`[Google Drive] 創建日期資料夾: ${dateFolder}`);
    const createResponse = await drive.files.create({
      requestBody: {
        name: dateFolder,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId]
      },
      supportsAllDrives: true
    });

    return createResponse.data.id;
  } catch (e) {
    console.error(`[Google Drive] 創建資料夾失敗: ${e.message}`);
    return null;
  }
}

// 主備份函數
async function backupInsta360ToGoogleDrive(google, auth, googleFolderId) {
  const tmpDir = path.join(process.cwd(), '.insta360_tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const email = process.env.INSTA360_EMAIL;
  const password = process.env.INSTA360_PASSWORD;

  if (!email || !password) {
    console.error('[INSTA360] ❌ 未設定 INSTA360_EMAIL 或 INSTA360_PASSWORD');
    return { ok: 0, total: 0, error: 'missing_credentials' };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // 登入 INSTA360
    const page = await login360(browser, email, password);

    // 獲取相簾文件
    const files = await fetchAlbumFiles(page);
    if (files.length === 0) {
      console.log('[INSTA360] 沒有新文件');
      await page.close();
      return { ok: 0, total: 0, message: 'no_files' };
    }

    // 今天日期資料夾
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }); // YYYY-MM-DD
    const dateFolderId = await getOrCreateDateFolder(google, auth, googleFolderId, today);
    if (!dateFolderId) {
      throw new Error('無法創建日期資料夾');
    }

    let uploadedCount = 0;
    for (const file of files) {
      const fileId = file.fileId || file.id;
      const fileName = file.fileName || file.name || 'unknown';
      const fileUrl = file.url || file.downloadUrl;

      if (!fileUrl) {
        console.warn(`[INSTA360] ⚠️ 跳過無下載鏈接的文件: ${fileName}`);
        continue;
      }

      // 下載檔案
      const filePath = path.join(tmpDir, fileName);
      const downloadOk = await downloadFile(page, fileUrl, fileName, filePath);
      if (!downloadOk) continue;

      // 上傳到 Google Drive
      const googleFileId = await uploadToGoogleDrive(google, auth, filePath, fileName, dateFolderId);
      if (googleFileId) {
        await saveBackupRecord(fileId, fileName, googleFileId, today);
        uploadedCount++;
      }

      // 清理臨時檔案
      try { fs.unlinkSync(filePath); } catch (e) {}
    }

    await page.close();

    console.log(`[INSTA360] ✅ 備份完成: ${uploadedCount}/${files.length}`);
    return { ok: uploadedCount, total: files.length };

  } catch (e) {
    console.error('[INSTA360] ❌ 備份失敗:', e.message);
    return { ok: 0, total: 0, error: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

// 刪除 7 天前的備份
async function deleteOldBackups(google, auth) {
  try {
    const oldBackups = await getOldBackups(7);
    if (oldBackups.length === 0) {
      console.log('[Google Drive] 沒有需要刪除的舊備份');
      return { ok: 0, total: 0 };
    }

    console.log(`[Google Drive] 準備刪除 ${oldBackups.length} 個 7 天前的備份`);

    const drive = google.drive({ version: 'v3', auth });
    let deletedCount = 0;

    for (const backup of oldBackups) {
      try {
        await drive.files.delete({
          fileId: backup.googleFileId,
          supportsAllDrives: true
        });

        const collection = await initBackupCollection();
        await collection.updateOne(
          { _id: backup._id },
          { $set: { status: 'deleted' } }
        );

        deletedCount++;
        console.log(`[Google Drive] ✅ 已刪除: ${backup.fileName}`);
      } catch (e) {
        console.error(`[Google Drive] ❌ 刪除失敗 ${backup.fileName}: ${e.message}`);
      }
    }

    return { ok: deletedCount, total: oldBackups.length };
  } catch (e) {
    console.error('[Google Drive] ❌ 刪除備份失敗:', e.message);
    return { ok: 0, total: oldBackups.length, error: e.message };
  }
}

module.exports = {
  backupInsta360ToGoogleDrive,
  deleteOldBackups
};
