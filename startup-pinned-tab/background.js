// On browser start: show the first pinned tab and close the blank New Tab page Chrome opened.
const isBlankNewTab = (tab) =>
  !tab.pinned && /^(chrome:\/\/(newtab|new-tab-page)\/?|chrome-search:\/\/|about:newtab)/.test(tab.pendingUrl || tab.url || '');

async function showFirstPinned() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  for (const win of windows) {
    const pinned = win.tabs.filter((t) => t.pinned).sort((a, b) => a.index - b.index);
    if (!pinned.length) continue;
    await chrome.tabs.update(pinned[0].id, { active: true });
    // only close blank New Tab pages, and only if other tabs remain in the window
    const blanks = win.tabs.filter(isBlankNewTab);
    if (blanks.length < win.tabs.length) await chrome.tabs.remove(blanks.map((t) => t.id));
  }
}

// The New Tab page may be created a moment after the startup event, so try twice.
chrome.runtime.onStartup.addListener(() => {
  setTimeout(showFirstPinned, 1200);
  setTimeout(showFirstPinned, 3500);
});
