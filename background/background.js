// Background Service Worker - 状态持久化与消息中继

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ attackState: null });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SAVE_ATTACK_STATE':
      chrome.storage.local.set({ attackState: message.state });
      sendResponse({ success: true });
      break;

    case 'GET_ATTACK_STATE':
      chrome.storage.local.get('attackState', (data) => {
        sendResponse({ state: data.attackState });
      });
      return true;

    case 'INJECT_CONTENT_SCRIPT':
      chrome.scripting.executeScript({
        target: { tabId: message.tabId },
        files: ['content/content.js']
      }).then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
  }
});
