import { defaultProfile, engineBaseUrl, runSettingsMigration } from './src/shared.js';

const byId = id => document.getElementById(id);
const status = byId('status');
const form = byId('connection-form');
let busy = false;

async function profileState() {
  const { profiles = [], activeId } = await chrome.storage.local.get(['profiles', 'activeId']);
  const entries = profiles.length ? profiles : [defaultProfile()];
  const active = entries.find(profile => profile.id === activeId) || entries[0];
  return { entries, active };
}

async function refresh() {
  const { active } = await profileState();
  const { bridgePairingCode } = await chrome.storage.local.get('bridgePairingCode');
  byId('active-profile').textContent = active.name;
  byId('disconnect').disabled = !bridgePairingCode;
}

async function selectBrowser(removeCode = false) {
  await chrome.runtime.sendMessage({ type: 'stop-all' });
  const { entries, active } = await profileState();
  const browserProfile = { ...active, engine: 'browser', voice: '', name: '浏览器语音' };
  await chrome.storage.local.set({
    profiles: entries.map(profile => profile.id === active.id ? browserProfile : profile),
    activeId: active.id
  });
  if (removeCode) await chrome.storage.local.remove('bridgePairingCode');
  await refresh();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const submit = form.querySelector('button[type=submit]');
  submit.disabled = true;
  byId('disconnect').disabled = true;
  status.textContent = '正在检查本机服务…';
  try {
    const pairingCode = byId('pairing-code').value.trim();
    const response = await fetch(engineBaseUrl('piper') + '/health', {
      headers: { 'X-VoiceDock-Pairing': pairingCode },
      signal: AbortSignal.timeout(3000),
      redirect: 'error'
    });
    if (response.status === 401) {
      status.textContent = '连接码不匹配。请核对安装窗口里的连接码。';
      return;
    }
    if (!response.ok || (await response.json()).version !== 'flash') {
      status.textContent = '无法连接 VoiceDock 云端服务。请运行 start-cloud.cmd。';
      return;
    }
    await chrome.storage.local.set({ bridgePairingCode: pairingCode });
    form.reset();
    status.textContent = '连接成功。打开扩展，点击「同步平台音色」并选择音色。';
    await refresh();
  } catch (_) {
    status.textContent = '本机服务未响应。请运行 start-cloud.cmd 后重试。';
  } finally {
    busy = false;
    submit.disabled = false;
    await refresh();
  }
});

byId('use-browser').onclick = () => selectBrowser().catch(showSettingsError);
byId('disconnect').onclick = async () => {
  try {
    await selectBrowser(true);
    status.textContent = '已断开云端连接，当前预设使用浏览器语音。';
  } catch (_) { showSettingsError(); }
};
byId('remove-profile').onclick = async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'stop-all' });
    const { entries, active } = await profileState();
    const remaining = entries.filter(profile => profile.id !== active.id);
    if (!remaining.length) remaining.push(defaultProfile());
    await chrome.storage.local.set({ profiles: remaining, activeId: remaining[0].id });
    await refresh();
  } catch (_) { showSettingsError(); }
};

function showSettingsError() {
  status.textContent = '设置保存失败，请重新打开此页面后重试。';
}

await runSettingsMigration(chrome.storage.local);
await refresh();
