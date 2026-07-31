(() => {
  const admin = document.getElementById('btcAdmin');
  const tools = admin?.querySelector('.btcAdminTools');
  if (!admin || !tools) return;

  const reportButton = document.createElement('button');
  reportButton.id = 'btcReport';
  reportButton.innerHTML = '<b>BTC trade review — all time</b><small>Build every BTC trade, decision, event, fill, P&amp;L path, and strategy-version result into a ZIP for ChatGPT analysis.</small>';
  tools.prepend(reportButton);

  const panel = document.createElement('div');
  panel.className = 'toolPanel btcReportPanel';
  panel.innerHTML = '<div class="toolPanelHead"><h2>BTC report export</h2><button id="btcReportDownload" class="ghost hidden">Download ZIP</button></div><pre id="btcReportOutput">Build the report when you are ready to upload the actual BTC trade ledger into ChatGPT.</pre>';
  tools.insertAdjacentElement('afterend', panel);

  const output = document.getElementById('btcReportOutput');
  const downloadButton = document.getElementById('btcReportDownload');
  if (!output || !downloadButton) return;

  let archiveUrl = null;
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const bytesLabel = value => {
    const bytes = Number(value) || 0;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
    return `${bytes} bytes`;
  };

  async function requestJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('a BTC report request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function releaseArchive() {
    if (archiveUrl) URL.revokeObjectURL(archiveUrl);
    archiveUrl = null;
    downloadButton.classList.add('hidden');
  }

  function showDownload(blob, filename) {
    releaseArchive();
    archiveUrl = URL.createObjectURL(blob);
    downloadButton.onclick = () => {
      const link = document.createElement('a');
      link.href = archiveUrl;
      link.download = filename || 'memebot-btc-trade-review-all-time.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
    downloadButton.classList.remove('hidden');
  }

  reportButton.onclick = async () => {
    reportButton.disabled = true;
    releaseArchive();
    output.textContent = 'Starting the all-time BTC trade-review job…';
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      let job = await requestJson('/api/btc-review-jobs', { method: 'POST' });
      const deadline = Date.now() + 10 * 60_000;
      while (job.status === 'queued' || job.status === 'building') {
        output.textContent = [
          'Building and compressing the complete BTC trade review on the server.',
          job.message || 'Collecting BTC evidence…',
          `Elapsed: ${job.elapsedSeconds || 0}s`,
          'The report includes database history, not only the trades currently visible on screen.',
        ].join('\n');
        if (Date.now() >= deadline) throw new Error('BTC report generation exceeded 10 minutes');
        await sleep(1_500);
        job = await requestJson(`/api/btc-review-jobs/${encodeURIComponent(job.id)}`);
      }
      if (job.status !== 'ready') throw new Error(job.error || 'the BTC report job did not complete');
      if (!Number.isInteger(job.totalChunks) || job.totalChunks < 1) throw new Error('the BTC ZIP has no downloadable parts');

      const parts = [];
      let received = 0;
      for (let index = 0; index < job.totalChunks; index++) {
        output.textContent = [
          `BTC report compressed: ${bytesLabel(job.resultBytes)} → ${bytesLabel(job.archiveBytes)} ZIP.`,
          `Receiving ZIP part ${index + 1} of ${job.totalChunks}…`,
        ].join('\n');
        const chunk = await requestJson(`/api/btc-review-jobs/${encodeURIComponent(job.id)}/chunks/${index}`);
        if (chunk.index !== index || chunk.totalChunks !== job.totalChunks
          || chunk.encoding !== 'base64' || typeof chunk.chunk !== 'string') {
          throw new Error(`BTC ZIP part ${index + 1} was invalid`);
        }
        const bytes = decodeBase64(chunk.chunk);
        received += bytes.byteLength;
        parts.push(bytes);
      }
      if (received !== Number(job.archiveBytes)) {
        throw new Error(`BTC ZIP size mismatch: received ${received}, expected ${job.archiveBytes}`);
      }
      showDownload(new Blob(parts, { type: 'application/zip' }), job.downloadFilename);
      output.textContent = [
        'BTC trade-review ZIP is ready.',
        `Original JSON: ${bytesLabel(job.resultBytes)}`,
        `Download size: ${bytesLabel(job.archiveBytes)}`,
        '',
        'Tap “Download ZIP,” then upload that ZIP directly into this ChatGPT conversation.',
        'The archive contains btc-trade-review-all-time.json with every persisted BTC trade and its research evidence.',
      ].join('\n');
    } catch (error) {
      output.textContent = `BTC trade review failed: ${error.message}`;
      releaseArchive();
    } finally {
      reportButton.disabled = false;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  window.addEventListener('pagehide', releaseArchive, { once: true });
})();
