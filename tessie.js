// ─── Tessie API 客戶端（Tesla 車輛查詢與控制）──────────────────
// 文件：https://developer.tessie.com
const axios = require('axios');

const BASE_URL = 'https://api.tessie.com';
const MILES_TO_KM = 1.609344;

function api() {
  const token = process.env.TESSIE_API_TOKEN;
  if (!token) throw new Error('TESSIE_API_TOKEN 未設定');
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 120000 // 指令會等車子醒來並執行完成，可能需要一段時間
  });
}

// 取得 VIN：優先用環境變數，否則抓帳號內第一台啟用中的車
let _cachedVin = null;
async function getVin() {
  if (process.env.TESSIE_VIN) return process.env.TESSIE_VIN;
  if (_cachedVin) return _cachedVin;
  const { data } = await api().get('/vehicles', { params: { only_active: true } });
  const vin = data.results?.[0]?.vin;
  if (!vin) throw new Error('Tessie 帳號內找不到車輛');
  _cachedVin = vin;
  return vin;
}

async function getState() {
  const vin = await getVin();
  const { data } = await api().get(`/${vin}/state`);
  return data;
}

async function getLocation() {
  const vin = await getVin();
  const { data } = await api().get(`/${vin}/location`);
  return data;
}

// 指令名稱 → Tessie 端點
const COMMANDS = {
  lock:          { path: 'command/lock',                 label: '🔒 上鎖' },
  unlock:        { path: 'command/unlock',               label: '🔓 解鎖' },
  climate_on:    { path: 'command/start_climate',        label: '❄️ 開啟空調' },
  climate_off:   { path: 'command/stop_climate',         label: '🛑 關閉空調' },
  set_temp:      { path: 'command/set_temperatures',     label: '❄️ 開啟空調' },
  charge_start:  { path: 'command/start_charging',       label: '⚡ 開始充電' },
  charge_stop:   { path: 'command/stop_charging',        label: '🔌 停止充電' },
  flash:         { path: 'command/flash',                label: '💡 閃燈' },
  honk:          { path: 'command/honk',                 label: '📯 按喇叭' },
  front_trunk:   { path: 'command/activate_front_trunk', label: '🧳 開前車廂' },
  rear_trunk:    { path: 'command/activate_rear_trunk',  label: '🧳 開/關後車廂' },
  wake:          { path: 'wake',                         label: '⏰ 喚醒車輛' }
};

// 會讓車子處於不安全狀態的指令，需要使用者再次確認
const SENSITIVE_COMMANDS = new Set(['unlock', 'front_trunk', 'rear_trunk']);

async function runCommand(action, params = {}) {
  const cmd = COMMANDS[action];
  if (!cmd) throw new Error(`未知指令：${action}`);
  const vin = await getVin();
  const query = { ...params };
  if (cmd.path.startsWith('command/')) query.wait_for_completion = true;
  const { data } = await api().post(`/${vin}/${cmd.path}`, null, { params: query });
  return data.result === true;
}

// ─── 訊息格式化 ──────────────────────────────────────────────
const CHARGING_STATE_ZH = {
  Charging: '充電中', Complete: '已充飽', Disconnected: '未接充電線',
  Stopped: '已停止', Starting: '開始中', NoPower: '充電樁無電'
};

function formatState(s) {
  const c = s.charge_state || {};
  const cl = s.climate_state || {};
  const v = s.vehicle_state || {};
  const rangeKm = c.battery_range != null ? Math.round(c.battery_range * MILES_TO_KM) : '-';
  const odoKm = v.odometer != null ? Math.round(v.odometer * MILES_TO_KM).toLocaleString() : '-';
  const lines = [
    `🚗 ${s.display_name || 'Tesla'}（${s.state === 'online' ? '在線' : s.state === 'asleep' ? '休眠中' : s.state || '未知'}）`,
    '',
    `🔋 電量：${c.battery_level ?? '-'}%（約 ${rangeKm} km）`,
    `⚡ 充電：${CHARGING_STATE_ZH[c.charging_state] || c.charging_state || '-'}`,
  ];
  if (c.charging_state === 'Charging' && c.minutes_to_full_charge) {
    lines.push(`⏱️ 預計 ${c.minutes_to_full_charge} 分鐘後充到 ${c.charge_limit_soc}%`);
  }
  lines.push(
    `🔐 門鎖：${v.locked ? '已上鎖' : '⚠️ 未上鎖'}`,
    `🌡️ 車內 ${cl.inside_temp ?? '-'}°C／車外 ${cl.outside_temp ?? '-'}°C`,
    `❄️ 空調：${cl.is_climate_on ? '開啟中' : '關閉'}`,
    `🛣️ 里程：${odoKm} km`
  );
  return lines.join('\n');
}

function formatLocation(loc) {
  const place = loc.saved_location ? `📌 ${loc.saved_location}\n` : '';
  return `📍 車輛位置\n\n${place}${loc.address || '（無地址資訊）'}\n\nhttps://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
}

module.exports = {
  COMMANDS,
  SENSITIVE_COMMANDS,
  getState,
  getLocation,
  runCommand,
  formatState,
  formatLocation
};
