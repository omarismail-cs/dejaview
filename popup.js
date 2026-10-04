const radios = document.querySelectorAll('input[name="mode"]');
const hint = document.getElementById('hint');
const stats = document.getElementById('stats');

const HINTS = {
  hide: 'Reposted jobs are removed from the list.',
  label: 'Reposted jobs are faded and tagged with their real age.',
  off: 'LinkedIn is left as it is.',
};

function line(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function refreshStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'nrl-stats' }, (res) => {
      stats.replaceChildren();
      if (chrome.runtime.lastError || !res) {
        stats.append(line('Open a LinkedIn jobs search to see reposts.'));
        return;
      }
      const count = document.createElement('strong');
      count.textContent = `${res.onPage} of ${res.total}`;
      const summary = line(' jobs here are reposts');
      summary.prepend(count);
      stats.append(summary);
      if (res.pending) stats.append(line(`Checking ${res.pending} more`));
      if (res.paused) stats.append(line('Paused for 5 minutes: LinkedIn refused a lookup.'));
    });
  });
}

chrome.storage.sync.get({ mode: 'hide' }, ({ mode }) => {
  hint.textContent = HINTS[mode];
  radios.forEach((radio) => {
    radio.checked = radio.value === mode;
    radio.addEventListener('change', () => {
      hint.textContent = HINTS[radio.value];
      chrome.storage.sync.set({ mode: radio.value }, () => setTimeout(refreshStats, 400));
    });
  });
});

refreshStats();
