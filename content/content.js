(() => {
  // 防止重复注入
  if (window.__loginCrackerInjected) return;
  window.__loginCrackerInjected = true;

  let pickMode = null;
  let highlightOverlay = null;
  let lastHoveredElement = null;

  // ==================== 消息处理 ====================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handleMessage(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  });

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'PING':
        return { pong: true };
      case 'AUTO_DETECT':
        return autoDetectElements();
      case 'START_PICK':
        return startPick(msg.elementType);
      case 'STOP_PICK':
        return stopPick();
      case 'FILL_INPUT':
        return fillInput(msg.selector, msg.value);
      case 'CLICK_ELEMENT':
        return clickElement(msg.selector);
      case 'REFRESH_CAPTCHA':
        return refreshCaptcha(msg.selector);
      case 'CAPTURE_CAPTCHA':
        return captureCaptcha(msg.selector);
      case 'CHECK_RESULT':
        return checkResult(msg.failText, msg.successText, msg.formSelector);
      case 'HIGHLIGHT_ELEMENTS':
        return highlightElements(msg.selectors);
      case 'CLEAR_HIGHLIGHTS':
        return clearHighlights();
      case 'ENABLE_ALERT_INTERCEPT':
        enableAlertIntercept();
        return { success: true };
      case 'DISABLE_ALERT_INTERCEPT':
        return { message: disableAlertIntercept() };
      case 'GET_ALERT_MESSAGE':
        return getAlertMessage();
      case 'GET_PAGE_TEXT':
        return { text: (document.body && document.body.innerText) || '' };
      default:
        return { error: 'Unknown message: ' + msg.type };
    }
  }

  // ==================== 自动检测表单元素 ====================
  function autoDetectElements() {
    const result = {
      username: null,
      password: null,
      captchaInput: null,
      captchaImg: null,
      submit: null,
    };

    // 1. 查找密码输入框
    const pwdFields = document.querySelectorAll(
      'input[type="password"]:not([hidden])'
    );
    if (pwdFields.length > 0) {
      result.password = generateSelector(pwdFields[0]);
    }

    // 2. 查找用户名输入框
    const textInputs = document.querySelectorAll(
      'input[type="text"], input[type="email"], input:not([type])'
    );
    for (const input of textInputs) {
      if (isHidden(input)) continue;
      const hint = [input.name, input.id, input.placeholder, input.className]
        .join(' ')
        .toLowerCase();
      if (
        hint.match(/user|name|login|email|account|用户|账号|帐号|uname|uid/)
      ) {
        result.username = generateSelector(input);
        break;
      }
    }
    // 回退：取密码框前面的第一个可见文本输入
    if (!result.username && result.password) {
      const pwdEl = document.querySelector(result.password);
      const allInputs = Array.from(
        document.querySelectorAll(
          'input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])'
        )
      );
      for (const input of allInputs) {
        if (isHidden(input)) continue;
        if (
          pwdEl &&
          input.compareDocumentPosition(pwdEl) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          result.username = generateSelector(input);
          break;
        }
      }
    }

    // 3. 查找验证码输入框
    for (const input of textInputs) {
      if (isHidden(input)) continue;
      if (result.username && generateSelector(input) === result.username)
        continue;
      if (result.password && generateSelector(input) === result.password)
        continue;
      const hint = [input.name, input.id, input.placeholder, input.className]
        .join(' ')
        .toLowerCase();
      if (
        hint.match(
          /captcha|verify|vcode|验证码|yanzhengma|checkcode|imgcode|seccode|authcode|yzm|validcode|validatecode|randcode|vericode/
        )
      ) {
        result.captchaInput = generateSelector(input);
        break;
      }
    }

    // 4. 查找验证码图片
    const images = document.querySelectorAll('img');
    for (const img of images) {
      if (isHidden(img)) continue;
      const hint = [img.src, img.id, img.className, img.alt, img.title, img.getAttribute('onclick') || '']
        .join(' ')
        .toLowerCase();
      if (
        hint.match(
          /captcha|verify|vcode|验证码|checkcode|seccode|kaptcha|authcode|yzm|imgcode|randcode|vericode|validatecode|codeimg|getcode/
        )
      ) {
        result.captchaImg = generateSelector(img);
        break;
      }
    }
    // 也检查 canvas 验证码
    if (!result.captchaImg) {
      const canvases = document.querySelectorAll('canvas');
      for (const c of canvases) {
        if (isHidden(c)) continue;
        const hint = [c.id, c.className].join(' ').toLowerCase();
        if (hint.match(/captcha|verify|code/)) {
          result.captchaImg = generateSelector(c);
          break;
        }
      }
    }

    // 回退：如果找到了验证码图片但没找到验证码输入框，在图片附近找文本输入框
    if (!result.captchaInput && result.captchaImg) {
      const captchaImgEl = document.querySelector(result.captchaImg);
      if (captchaImgEl) {
        // 找同一父容器内的输入框
        const parent = captchaImgEl.closest('tr, .form-group, .form-item, .input-group, .captcha, .verify, form, div');
        if (parent) {
          for (const input of parent.querySelectorAll('input[type="text"], input:not([type])')) {
            if (isHidden(input)) continue;
            const sel = generateSelector(input);
            if (sel === result.username || sel === result.password) continue;
            result.captchaInput = sel;
            break;
          }
        }
      }
      // 再回退：找除了用户名密码外的剩余可见文本输入框
      if (!result.captchaInput) {
        for (const input of textInputs) {
          if (isHidden(input)) continue;
          const sel = generateSelector(input);
          if (sel === result.username || sel === result.password) continue;
          result.captchaInput = sel;
          break;
        }
      }
    }

    // 回退：如果找到了验证码输入框但没找到验证码图片，尝试附近的图片
    if (!result.captchaImg && result.captchaInput) {
      const captchaEl = document.querySelector(result.captchaInput);
      if (captchaEl) {
        const parent = captchaEl.closest('tr, .form-group, .form-item, .input-group, .captcha, .verify, .code, div');
        if (parent) {
          const nearbyImg = parent.querySelector('img');
          if (nearbyImg && !isHidden(nearbyImg)) {
            result.captchaImg = generateSelector(nearbyImg);
          }
        }
        if (!result.captchaImg) {
          for (const img of images) {
            if (isHidden(img)) continue;
            const w = img.naturalWidth || img.offsetWidth;
            const h = img.naturalHeight || img.offsetHeight;
            if (w >= 50 && w <= 250 && h >= 20 && h <= 80) {
              const src = (img.src || '').toLowerCase();
              if (!src.match(/logo|icon|avatar|banner|favicon/)) {
                result.captchaImg = generateSelector(img);
                break;
              }
            }
          }
        }
      }
    }

    // 5. 查找提交按钮
    // 收集所有表单内和页面上的按钮候选
    const form = document.querySelector('form');
    const btnCandidates = [];
    // 优先搜索表单内的按钮
    if (form) {
      btnCandidates.push(
        ...form.querySelectorAll('button[type="submit"], input[type="submit"]'),
        ...form.querySelectorAll('button'),
        ...form.querySelectorAll('input[type="button"]'),
        ...form.querySelectorAll('a.btn, a.button, a[href="javascript"]'),
        ...form.querySelectorAll('[role="button"]'),
        ...form.querySelectorAll('div[onclick], span[onclick]'),
      );
    }
    // 全局补充（包含所有可点击元素）
    btnCandidates.push(
      ...document.querySelectorAll('button[type="submit"], input[type="submit"]'),
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('input[type="button"]'),
      ...document.querySelectorAll('a.btn, a.button'),
      ...document.querySelectorAll('[role="button"]'),
      ...document.querySelectorAll('input[onclick], div[onclick], a[onclick]'),
    );
    // 去重
    const seenBtns = new Set();
    for (const btn of btnCandidates) {
      if (seenBtns.has(btn) || isHidden(btn)) continue;
      seenBtns.add(btn);
      const text = (btn.textContent || btn.value || btn.title || btn.getAttribute('aria-label') || '').trim().toLowerCase();
      const hint = [btn.id, btn.className, btn.name, btn.getAttribute('onclick') || ''].join(' ').toLowerCase();
      if (
        text.match(/登录|登\ *录|login|sign\s*in|log\s*in|submit|确定|提交|进入|登入/) ||
        hint.match(/login|submit|signin|loginbtn|btn.?login|btn.?submit|dengl|denglu|log_in/)
      ) {
        result.submit = generateSelector(btn);
        break;
      }
    }
    // 回退1：表单中的第一个提交按钮
    if (!result.submit && form) {
      const submitBtn = form.querySelector(
        'button[type="submit"], input[type="submit"], button:not([type])'
      );
      if (submitBtn) result.submit = generateSelector(submitBtn);
    }
    // 回退2：页面上找到密码框附近的按钮/可点击元素
    if (!result.submit && result.password) {
      const pwdEl = document.querySelector(result.password);
      if (pwdEl) {
        // 从密码框往后找最近的可点击元素
        let sibling = pwdEl.parentElement;
        for (let i = 0; i < 5 && sibling; i++) {
          sibling = sibling.nextElementSibling;
          if (!sibling) break;
          const clickable = sibling.querySelector('input[type="button"], input[type="submit"], button, [onclick]')
            || (sibling.matches('input[type="button"], input[type="submit"], button, [onclick]') ? sibling : null);
          if (clickable && !isHidden(clickable)) {
            result.submit = generateSelector(clickable);
            break;
          }
        }
      }
    }
    // 回退3：全页面找唯一的输入按钮
    if (!result.submit) {
      const allBtns = document.querySelectorAll('input[type="button"], input[type="submit"], button[type="submit"]');
      const visibleBtns = Array.from(allBtns).filter(b => !isHidden(b));
      if (visibleBtns.length === 1) {
        result.submit = generateSelector(visibleBtns[0]);
      }
    }

    return result;
  }

  // ==================== 元素拾取模式 ====================
  function startPick(elementType) {
    pickMode = elementType;
    createOverlay();
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKeyDown, true);
    document.body.style.cursor = 'crosshair';
    return { success: true };
  }

  function stopPick() {
    pickMode = null;
    removeOverlay();
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKeyDown, true);
    document.body.style.cursor = '';
    lastHoveredElement = null;
    return { success: true };
  }

  function createOverlay() {
    if (highlightOverlay) return;
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = '__lc_overlay';
    highlightOverlay.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483647;' +
      'border:2px solid #6c5ce7;background:rgba(108,92,231,0.18);' +
      'transition:all .08s ease;display:none;border-radius:3px;';
    document.body.appendChild(highlightOverlay);
  }

  function removeOverlay() {
    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
    }
  }

  function onPickMove(e) {
    if (!pickMode || !highlightOverlay) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === highlightOverlay) return;
    lastHoveredElement = el;
    const rect = el.getBoundingClientRect();
    Object.assign(highlightOverlay.style, {
      display: 'block',
      left: rect.left + 'px',
      top: rect.top + 'px',
      width: rect.width + 'px',
      height: rect.height + 'px',
    });
  }

  function onPickClick(e) {
    if (!pickMode) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el =
      lastHoveredElement ||
      document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;

    const selector = generateSelector(el);
    const type = pickMode;
    stopPick();

    chrome.runtime.sendMessage({
      type: 'ELEMENT_PICKED',
      elementType: type,
      selector: selector,
    });
  }

  function onPickKeyDown(e) {
    if (e.key === 'Escape') {
      stopPick();
      chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' });
    }
  }

  // ==================== 模拟表单交互 ====================
  function fillInput(selector, value) {
    const el = document.querySelector(selector);
    if (!el) return { error: '元素未找到: ' + selector };

    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    // 清空
    el.value = '';
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'deleteContent' })
    );

    // 使用原生 setter 触发框架绑定（React / Vue / Angular）
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }

    // 派发完整的输入事件链
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: value,
        inputType: 'insertText',
      })
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));

    return { success: true };
  }

  function clickElement(selector) {
    const el = document.querySelector(selector);
    if (!el) return { error: '元素未找到: ' + selector };

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
    };

    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));

    // 部分站点仅监听 el.click()
    if (typeof el.click === 'function') el.click();

    return { success: true };
  }

  // ==================== 验证码处理 ====================

  // Alert 拦截系统
  // content.js 运行在隔离世界，无法直接覆盖页面的 window.alert
  // 因此通过 <script> 标签注入到 MAIN world，用 sessionStorage 通信

  // 页面加载时，检查 document_start 拦截器（MAIN world）是否已捕获 alert
  let earlyAlertMsg = '';
  let earlyAlertCaptured = false;
  try {
    if (sessionStorage.getItem('__lc_alert_intercepted') === '1') {
      earlyAlertCaptured = true;
      earlyAlertMsg = sessionStorage.getItem('__lc_alert_msg') || '';
      sessionStorage.removeItem('__lc_alert_intercepted');
      sessionStorage.removeItem('__lc_alert_msg');
    }
  } catch (e) {}

  function injectMainWorldScript(code) {
    try {
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) {}
  }

  function enableAlertIntercept() {
    earlyAlertCaptured = false;
    earlyAlertMsg = '';
    // 清除之前可能残留的 sessionStorage
    try {
      sessionStorage.removeItem('__lc_alert_intercepted');
      sessionStorage.removeItem('__lc_alert_msg');
    } catch (e) {}
    // 设置标志，供页面重载后 document_start 拦截器使用
    try { sessionStorage.setItem('__lc_intercept_alerts', '1'); } catch (e) {}
    // 注入到 MAIN world：覆盖 alert/confirm，将消息写入 sessionStorage
    injectMainWorldScript(`
      (function() {
        if (window.__lc_alertActive) return;
        window.__lc_alertActive = true;
        if (!window.__lc_origAlert) window.__lc_origAlert = window.alert;
        if (!window.__lc_origConfirm) window.__lc_origConfirm = window.confirm;
        window.alert = function(msg) {
          try { sessionStorage.setItem('__lc_alert_msg', String(msg)); } catch(e) {}
          try { sessionStorage.setItem('__lc_alert_intercepted', '1'); } catch(e) {}
        };
        window.confirm = function(msg) {
          try { sessionStorage.setItem('__lc_alert_msg', String(msg)); } catch(e) {}
          try { sessionStorage.setItem('__lc_alert_intercepted', '1'); } catch(e) {}
          return true;
        };
      })();
    `);
  }

  function disableAlertIntercept() {
    // 先从 sessionStorage 读取可能被 MAIN world 捕获的 alert
    let msg = earlyAlertMsg;
    try {
      if (sessionStorage.getItem('__lc_alert_intercepted') === '1') {
        msg = sessionStorage.getItem('__lc_alert_msg') || msg;
      }
    } catch (e) {}
    earlyAlertCaptured = false;
    earlyAlertMsg = '';
    // 在 MAIN world 恢复原始 alert/confirm
    injectMainWorldScript(`
      (function() {
        if (window.__lc_origAlert) window.alert = window.__lc_origAlert;
        if (window.__lc_origConfirm) window.confirm = window.__lc_origConfirm;
        window.__lc_alertActive = false;
      })();
    `);
    // 清除 sessionStorage
    try {
      sessionStorage.removeItem('__lc_intercept_alerts');
      sessionStorage.removeItem('__lc_alert_intercepted');
      sessionStorage.removeItem('__lc_alert_msg');
    } catch (e) {}
    return msg;
  }

  function getAlertMessage() {
    // 优先读取 document_start 阶段捕获的 alert（页面重载场景）
    if (earlyAlertCaptured) {
      return { intercepted: true, message: earlyAlertMsg };
    }
    // 读取 MAIN world 运行时捕获的 alert（AJAX 场景）
    try {
      if (sessionStorage.getItem('__lc_alert_intercepted') === '1') {
        const msg = sessionStorage.getItem('__lc_alert_msg') || '';
        return { intercepted: true, message: msg };
      }
    } catch (e) {}
    return { intercepted: false, message: '' };
  }

  async function refreshCaptcha(selector) {
    const el = document.querySelector(selector);
    if (!el) return { error: '验证码元素未找到: ' + selector };

    if (el.tagName === 'IMG') {
      // 记录旧 src 用于验证确实变了
      const oldSrc = el.src;

      // 直接修改 src 强制刷新，不要依赖点击
      const baseSrc = el.src.replace(/([?&])(_t|str|r|random|v|t|_)=[^&]*/g, '').replace(/[?&]$/, '');
      const sep = baseSrc.includes('?') ? '&' : '?';
      const newSrc = baseSrc + sep + '_t=' + Date.now() + Math.random();

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          el.removeEventListener('load', onLoad);
          el.removeEventListener('error', onError);
          resolve({ success: true, timedOut: true });
        }, 8000);

        const onLoad = async () => {
          clearTimeout(timeout);
          el.removeEventListener('load', onLoad);
          el.removeEventListener('error', onError);
          // 等待图片完全解码，确保 canvas drawImage 可用
          if (typeof el.decode === 'function') {
            try { await el.decode(); } catch {}
          }
          // 额外等待渲染
          setTimeout(() => resolve({ success: true }), 300);
        };

        const onError = () => {
          clearTimeout(timeout);
          el.removeEventListener('load', onLoad);
          el.removeEventListener('error', onError);
          resolve({ error: '验证码图片加载失败' });
        };

        el.addEventListener('load', onLoad);
        el.addEventListener('error', onError);
        el.src = newSrc;
      });
    } else {
      // Canvas 或其他元素 —— 直接点击
      el.click();
      return new Promise(r => setTimeout(() => r({ success: true }), 800));
    }
  }

  async function captureCaptcha(selector) {
    const el = document.querySelector(selector);
    if (!el) return { error: '验证码元素未找到: ' + selector };

    if (el.tagName === 'CANVAS') {
      try {
        return { success: true, dataUrl: el.toDataURL('image/png') };
      } catch (e) {
        return { error: '无法捕获 canvas 验证码: ' + e.message };
      }
    }

    if (el.tagName === 'IMG') {
      // 轮询等待图片完全加载（最多 6 秒）
      const maxWait = 6000;
      const pollInterval = 200;
      let waited = 0;
      while ((!el.complete || el.naturalWidth === 0) && waited < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));
        waited += pollInterval;
      }

      // 如果仍未加载，尝试监听 load 事件
      if (!el.complete || el.naturalWidth === 0) {
        await new Promise((r) => {
          el.addEventListener('load', r, { once: true });
          setTimeout(r, 3000);
        });
      }

      // 确保图片已解码（防止 drawImage 拿到空白图）
      if (typeof el.decode === 'function') {
        try { await el.decode(); } catch {}
      }

      // 用 canvas 截取当前显示的图片（不能用 fetch，会触发服务端生成新验证码）
      const w = el.naturalWidth || el.width;
      const h = el.naturalHeight || el.height;
      if (w > 0 && h > 0) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(el, 0, 0, w, h);
          // 验证是否被污染
          ctx.getImageData(0, 0, 1, 1);
          return { success: true, dataUrl: canvas.toDataURL('image/png') };
        } catch (e) {
          return { error: 'Canvas 截图失败 (可能跨域): ' + e.message };
        }
      }

      return { error: '验证码图片尺寸为 0 (' + w + 'x' + h + ')，可能还在加载' };
    }

    return { error: '不支持的验证码元素类型: ' + el.tagName };
  }

  // ==================== 结果检测 ====================
  const FAIL_PATTERN = /错误|失败|有误|不正确|不匹配|不存在|密码错|账号错|用户名或密码|登录错|认证失败|无效|拒绝|禁止|账户锁|验证码错|error|fail|wrong|invalid|incorrect|denied|forbidden|unauthorized|locked|mismatch/i;
  const SUCCESS_PATTERN = /成功|欢迎|主页|后台|控制台|仪表盘|首页|success|welcome|dashboard|home|panel|console|index/i;

  function checkResult(failText, successText, formSelector) {
    const pageText = document.body.innerText || '';
    const pageUrl = location.href;
    const formExists = formSelector ? !!document.querySelector(formSelector) : null;

    // 用户自定义关键词优先
    if (successText && pageText.includes(successText)) {
      return { loginResult: 'success', reason: '匹配成功关键词: ' + successText };
    }
    if (failText && pageText.includes(failText)) {
      return { loginResult: 'fail', reason: '匹配失败关键词: ' + failText };
    }

    // 返回页面信息，由 popup.js 统一判断
    return {
      loginResult: '__pending__',
      pageText: pageText.substring(0, 2000),
      pageUrl: pageUrl,
      formExists: formExists,
    };
  }

  // ==================== 元素高亮 ====================
  const HIGHLIGHT_COLORS = {
    username: '#3498db',
    password: '#e74c3c',
    captchaInput: '#f39c12',
    captchaImg: '#2ecc71',
    submit: '#9b59b6',
  };

  function highlightElements(selectors) {
    clearHighlights();
    for (const [key, selector] of Object.entries(selectors)) {
      if (!selector) continue;
      const el = document.querySelector(selector);
      if (!el) continue;
      el.dataset.lcHighlight = key;
      el.style.outline = '3px solid ' + (HIGHLIGHT_COLORS[key] || '#6c5ce7');
      el.style.outlineOffset = '2px';
    }
    return { success: true };
  }

  function clearHighlights() {
    document.querySelectorAll('[data-lc-highlight]').forEach((el) => {
      el.style.outline = '';
      el.style.outlineOffset = '';
      delete el.dataset.lcHighlight;
    });
    return { success: true };
  }

  // ==================== 工具函数 ====================
  function generateSelector(el) {
    if (!el) return null;

    // 优先使用 ID
    if (el.id) {
      const escaped = CSS.escape(el.id);
      if (document.querySelectorAll('#' + escaped).length === 1) {
        return '#' + escaped;
      }
    }

    // 尝试 name 属性
    if (el.name) {
      const sel =
        el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 尝试 type + name / placeholder 组合
    if (el.tagName === 'INPUT' && el.type) {
      if (el.name) {
        const sel =
          'input[type="' +
          el.type +
          '"][name="' +
          CSS.escape(el.name) +
          '"]';
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      if (el.placeholder) {
        const sel =
          'input[type="' +
          el.type +
          '"][placeholder="' +
          CSS.escape(el.placeholder) +
          '"]';
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // 构建路径选择器
    const path = [];
    let cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) {
        path.unshift('#' + CSS.escape(cur.id));
        break;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === cur.tagName
        );
        if (siblings.length > 1) {
          seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        }
      }
      path.unshift(seg);
      cur = cur.parentElement;
    }

    return path.join(' > ');
  }

  function isHidden(el) {
    if (!el) return true;
    if (el.hidden || el.type === 'hidden') return true;
    const s = window.getComputedStyle(el);
    return (
      s.display === 'none' ||
      s.visibility === 'hidden' ||
      s.opacity === '0' ||
      (el.offsetWidth === 0 && el.offsetHeight === 0)
    );
  }
})();
