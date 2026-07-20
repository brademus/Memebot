// Keep the existing operations output/copy flow, but make the report control produce one
// complete 24-hour review with cumulative evidence and the full trade ledger.
const dailyReviewButton = document.getElementById('report');
if (dailyReviewButton) {
  dailyReviewButton.onclick = () => runTool(
    '/api/report?days=1',
    'Building the complete daily master review with every trade and cumulative evidence…',
    true,
  );
}
