// Generate the complete report outside the browser request timeout, then retrieve it in
// bounded chunks. The user still gets one button, one output, and one copyable JSON review.
const dailyReviewButton = document.getElementById('report');
const dailyReviewOutput = document.getElementById('toolOutput');
const dailyReviewCopyButton = document.getElementById('copyTool');

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

async function runDailyMasterReview() {
  if (!dailyReviewButton || !dailyReviewOutput || !dailyReviewCopyButton) return;
  dailyReviewButton.disabled = true;
  dailyReviewCopyButton.classList.add('hidden');
  lastToolText = '';
  dailyReviewOutput.textContent = 'Starting the Daily Master Review job…';
  dailyReviewOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    let job = await dailyReviewJson('/api/daily-review-jobs?days=1', { method: 'POST' });
    const deadline = Date.now() + 10 * 60_000;

    while (job.status === 'queued' || job.status === 'building') {
      dailyReviewOutput.textContent = [
        'Building the complete Daily Master Review on the server.',
        job.message || 'Collecting evidence…',
        `Elapsed: ${job.elapsedSeconds || 0}s`,
        'You can stay on this screen; the dashboard is checking progress automatically.',
      ].join('\n');
      if (Date.now() >= deadline) throw new Error('report generation exceeded 10 minutes');
      await dailyReviewSleep(1_500);
      job = await dailyReviewJson(`/api/daily-review-jobs/${encodeURIComponent(job.id)}`);
    }

    if (job.status !== 'ready') throw new Error(job.error || 'the report job did not complete');
    if (!Number.isInteger(job.totalChunks) || job.totalChunks < 1) throw new Error('the completed report has no downloadable chunks');

    const chunks = [];
    for (let index = 0; index < job.totalChunks; index++) {
      dailyReviewOutput.textContent = [
        `Daily Master Review ready (${dailyReviewBytes(job.resultBytes)}).`,
        `Downloading part ${index + 1} of ${job.totalChunks}…`,
      ].join('\n');
      const result = await dailyReviewJson(
        `/api/daily-review-jobs/${encodeURIComponent(job.id)}/chunks/${index}`,
      );
      if (result.index !== index || result.totalChunks !== job.totalChunks || typeof result.chunk !== 'string') {
        throw new Error(`report part ${index + 1} was invalid`);
      }
      chunks.push(result.chunk);
    }

    const reportText = chunks.join('');
    JSON.parse(reportText);
    lastToolText = reportText;
    dailyReviewOutput.textContent = reportText;
    dailyReviewCopyButton.classList.remove('hidden');
    await copyToolText();
  } catch (error) {
    lastToolText = '';
    dailyReviewOutput.textContent = `Daily Master Review failed: ${error.message}`;
    dailyReviewCopyButton.classList.add('hidden');
  } finally {
    dailyReviewButton.disabled = false;
    dailyReviewOutput.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

if (dailyReviewButton) dailyReviewButton.onclick = runDailyMasterReview;
