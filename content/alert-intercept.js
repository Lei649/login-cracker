// 在 document_start 阶段运行于 MAIN world，早于任何页面脚本
// 用 sessionStorage 标志判断是否需要拦截 alert（爆破进行中）
(() => {
  try {
    if (sessionStorage.getItem('__lc_intercept_alerts') !== '1') return;
  } catch (e) { return; }

  // 保存原始函数
  const origAlert = window.alert;
  const origConfirm = window.confirm;
  window.__lc_origAlert = origAlert;
  window.__lc_origConfirm = origConfirm;

  window.alert = function (msg) {
    try {
      sessionStorage.setItem('__lc_alert_msg', String(msg));
      sessionStorage.setItem('__lc_alert_intercepted', '1');
    } catch (e) {}
  };

  window.confirm = function (msg) {
    try {
      sessionStorage.setItem('__lc_alert_msg', String(msg));
      sessionStorage.setItem('__lc_alert_intercepted', '1');
    } catch (e) {}
    return true;
  };
})();
