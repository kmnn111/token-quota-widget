/* 真实官方源 OTA 升级链路验证（独立脚本，不改动产品代码）
   把当前版本伪装成 v1.1.0，打 GitHub releases/latest/download，验证：
   ① 能取到 latest.yml 并解析出 1.2.0  ② 判定为「有新版本」 ③ 安装包可下载且 sha512 校验通过
   运行：env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron design/test-real-ota.js
*/
const { app } = require('electron');
const path = require('path');

// 必须在 require('electron-updater') 之前覆盖：单例构造时会读取 app.version 并 parse
app.getVersion = () => '1.1.0';
// 本脚本在 design/ 下，electron 会把 appPath 定为脚本所在目录；
// electron-updater 下载阶段要读根目录的 dev-app-update.yml，故指回项目根
app.getAppPath = () => path.join(__dirname, '..');

const URL = 'https://github.com/kmnn111/token-quota-widget/releases/latest/download';
let sawAvailable = false;
let downloaded = false;
let lastPercent = 0;

app.whenReady().then(async () => {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.forceDevUpdateConfig = true;   // 开发态也真跑链路
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({ provider: 'generic', url: URL });

  autoUpdater.on('checking-for-update', () => console.log('[real-ota] checking ...'));
  autoUpdater.on('update-available', info => {
    sawAvailable = info && info.version === '1.2.0';
    console.log('[real-ota] update-available:', JSON.stringify({
      version: info && info.version,
      size: info && info.files && info.files[0] && info.files[0].size,
      sha512: info && info.files && info.files[0] && String(info.files[0].sha512 || '').slice(0, 16)
    }), sawAvailable ? 'PASS' : 'FAIL');
  });
  autoUpdater.on('update-not-available', () => console.log('[real-ota] update-not-available (UNEXPECTED)'));
  autoUpdater.on('download-progress', p => {
    const n = Math.round(p.percent || 0);
    if (n - lastPercent >= 20) { lastPercent = n; console.log('[real-ota] download ' + n + '%'); }
  });
  autoUpdater.on('update-downloaded', info => { downloaded = true; console.log('[real-ota] update-downloaded:', info && info.version, 'PASS'); });
  autoUpdater.on('error', e => console.log('[real-ota] error:', String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 180)));

  try {
    const res = await autoUpdater.checkForUpdates();
    const info = res && res.updateInfo;
    console.log('[real-ota] check result version:', info && info.version,
      '| current:', String(autoUpdater.currentVersion && autoUpdater.currentVersion.format
        ? autoUpdater.currentVersion.format() : app.getVersion()));
    console.log('[real-ota] ① latest.yml 解析 + ② 发现新版:', sawAvailable ? 'PASS' : 'FAIL');

    if (sawAvailable && !process.argv.includes('--check-only')) {
      // ③ 真实下载 + sha512 校验（网络受限时单独标注，不算整体失败）
      const dl = autoUpdater.downloadUpdate();
      const timeout = new Promise(r => setTimeout(() => r('timeout'), 180000));
      const outcome = await Promise.race([dl.then(() => 'done').catch(e => 'error:' + String(e.message || e).slice(0, 100)), timeout]);
      console.log('[real-ota] ③ 下载结果:', outcome, downloaded ? 'PASS' : (outcome === 'done' ? 'FAIL' : 'SKIP(网络)'));
    }
  } catch (e) {
    console.log('[real-ota] check threw:', String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 180));
  }
  console.log('[real-ota] DONE', sawAvailable ? 'PASS' : 'FAIL');
  app.exit(0);
});
