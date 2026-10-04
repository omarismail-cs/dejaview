const radios = document.querySelectorAll('input[name="mode"]');
const stats = document.getElementById('stats');

function refreshStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'nrl-stats' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        stats.textContent = 'Open a LinkedIn jobs page to see counts.';
        return;
      }
      stats.textContent =
        `${res.onPage} of ${res.total} jobs loaded here are reposts` +
        (res.pending ? ` · checking ${res.pending} more` : '') +
        (res.paused ? ' · paused, LinkedIn refused a lookup' : '');
    });
  });
}

chrome.storage.sync.get({ mode: 'hide' }, ({ mode }) => {
  radios.forEach((radio) => {
    radio.checked = radio.value === mode;
    radio.addEventListener('change', () => {
      chrome.storage.sync.set({ mode: radio.value }, () => setTimeout(refreshStats, 400));
    });
  });
});

refreshStats();
