chrome.runtime.onInstalled.addListener(() => {
  console.log('Display Color Tools installed');
});

chrome.action.onClicked.addListener((tab) => {
  chrome.action.openPopup();
});