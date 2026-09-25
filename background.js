// The toolbar icon opens the prompt composer, which is the only reliable way to
// send a multi-line prompt: a URL cannot legally contain CR/LF, so browsers
// flatten line breaks typed into the address bar before the page ever sees them.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('composer.html') });
});
