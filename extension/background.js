// 확장 아이콘을 누르면 옆 패널이 열린다.
// (아이콘을 누른 탭에 대해 탭 소리 캡처 권한이 생긴다)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
