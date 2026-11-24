// 확장 아이콘 클릭을 직접 받아서 옆 패널을 연다.
// (openPanelOnActionClick을 쓰면 크롬이 클릭을 패널 열기에만 쓰고 activeTab 권한을 주지 않아서
//  탭 소리를 가져올 수 없다. 이렇게 직접 받아야 클릭한 탭에 대한 캡처 권한이 생긴다.)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  // 사용자 클릭 처리 중에 바로 불러야 열린다
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// 패널에서 캡처 권한을 못 얻었을 때 대신 시도한다
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "getStreamId") {
    chrome.tabCapture
      .getMediaStreamId({ targetTabId: msg.tabId })
      .then((id) => sendResponse({ id }))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
});
