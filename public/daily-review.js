// Build the complete report on the server, retrieve only its compressed ZIP bytes, and
// expose a download button. Safari never joins, parses, renders, or copies the giant JSON.
const dailyReviewButton = document.getElementById('report');
const dailyReviewOutput = document.getElementById('toolOutput');
const dailyReviewCopyButton = document.getElementById('copyTool');
const dailyReviewDefaultCopyHandler = dailyReviewCopyButton?.onclick || null;
let dailyReviewArchiveUrl = null;

const dailyReviewSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const dailyReviewBytes = value => {
  const bytes = Number(value) || 0;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
};

async function dailyReviewJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('a report status request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function dailyReviewDecodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function dailyReviewReleaseArchive() {
  if (dailyReviewArchiveUrl) URL.revokeObjectURL(dailyReviewArchiveUrl);
  dailyReviewArchiveUrl = null;
}

function dailyReviewRestoreCopyButton() {
  dailyReviewReleaseArchive();
  if (!dailyReviewCopyButton) return;
  dailyReviewCopyButton.textContent = 'Copy';
  dailyReviewCopyButton.onclick = dailyReviewDefaultCopyHandler;
  dailyReviewCopyButton.classList.add('hidden');
}

function dailyReviewShowDownload(blob, filename) {
  dailyReviewReleaseArchive();
  dailyReviewArchiveUrl = URL.createObjectURL(blob);
  dailyReviewCopyButton.textContent = 'Download ZIP';
  dailyReviewCopyButton.onclick = () => {
    const link = document.createElement('a');
    link.href = dailyReviewArchiveUrl;
    link.download = filename || 'memebot-daily-master-review.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  dailyReviewCopyButton.classList.remove('hidden');
}

async function runDailyMasterReview() {
  if (!dailyReviewButton || !dailyReviewOutput || !dailyReviewCopyButton) return;
  dailyReviewButton.disabled = true;
  dailyReviewRestoreCopyButton();
  lastToolText = '';
  dailyReviewOutput.textContent = 'Starting the Daily Master Review ZIP job…';
  dailyReviewOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    let job = await dailyReviewJson('/api/daily-review-jobs?days=1', { method: 'POST' });
    const deadline = Date.now() + 10 * 60_000;

    while (job.status === 'queued' || job.status === 'building') {
      dailyReviewOutput.textContent = [
        'Building and compressing the complete Daily Master Review on the server.',
        job.message || 'Collecting evidence…',
        `Elapsed: ${job.elapsedSeconds || 0}s`,
        'The phone will receive a ZIP file instead of rendering the large JSON.',
      ].join('\n');
      if (Date.now() >= deadline) throw new Error('report generation exceeded 10 minutes');
      await dailyReviewSleep(1_500);
      job = await dailyReviewJson(`/api/daily-review-jobs/${encodeURIComponent(job.id)}`);
    }

    if (job.status !== 'ready') throw new Error(job.error || 'the report job did not complete');
    if (!Number.isInteger(job.totalChunks) || job.totalChunks < 1) throw new Error('the ZIP file has no downloadable parts');

    const archiveParts = [];
    let archiveBytesReceived = 0;
    for (let index = 0; index < job.totalChunks; index++) {
      dailyReviewOutput.textContent = [
        `Daily Master Review compressed: ${dailyReviewBytes(job.resultBytes)} → ${dailyReviewBytes(job.archiveBytes)} ZIP.`,
        `Receiving ZIP part ${index + 1} of ${job.totalChunks}…`,
      ].join('\n');
      const result = await dailyReviewJson(
        `/api/daily-review-jobs/${encodeURIComponent(job.id)}/chunks/${index}`,
      );
      if (result.index !== index || result.totalChunks !== job.totalChunks
        || result.encoding !== 'base64' || typeof result.chunk !== 'string') {
        throw new Error(`ZIP part ${index + 1} was invalid`);
      }
      const bytes = dailyReviewDecodeBase64(result.chunk);
      archiveBytesReceived += bytes.byteLength;
      archiveParts.push(bytes);
    }

    if (archiveBytesReceived !== Number(job.archiveBytes)) {
      throw new Error(`ZIP size mismatch: received ${archiveBytesReceived}, expected ${job.archiveBytes}`);
    }
    const archive = new Blob(archiveParts, { type: 'application/zip' });
    dailyReviewShowDownload(archive, job.downloadFilename);
    dailyReviewOutput.textContent = [
      'Daily Master Review ZIP is ready.',
      `Original JSON: ${dailyReviewBytes(job.resultBytes)}`,
      `Download size: ${dailyReviewBytes(job.archiveBytes)}`,
      '',
      'Tap “Download ZIP” above, then upload that ZIP file directly into this ChatGPT conversation.',
      'The archive contains daily-master-review.json with the complete review.',
    ].join('\n');
  } catch (error) {
    lastToolText = '';
    dailyReviewOutput.textContent = `Daily Master Review failed: ${error.message}`;
    dailyReviewRestoreCopyButton();
  } finally {
    dailyReviewButton.disabled = false;
    dailyReviewOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Restore normal Copy behavior before any other operations tool runs.
document.querySelectorAll('.adminTools button').forEach(button => {
  if (button !== dailyReviewButton) button.addEventListener('click', dailyReviewRestoreCopyButton, { capture: true });
});

if (dailyReviewButton) dailyReviewButton.onclick = runDailyMasterReview;
