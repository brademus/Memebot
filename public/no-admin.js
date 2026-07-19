// Admin authentication is intentionally disabled for the current private-use app.
// Override the legacy helper so tools make ordinary requests without prompting,
// storing, or transmitting an admin key.
window.adminJson = async function adminJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
};

// Keep the existing element id so the older app bundle cannot throw, but repurpose
// the control as a simple output reset instead of a credential action.
const resetButton = document.getElementById('clearAdminKey');
if (resetButton) {
  resetButton.onclick = () => {
    sessionStorage.removeItem('memewatchAdminKey');
    const output = document.getElementById('toolOutput');
    const copy = document.getElementById('copyTool');
    if (output) output.textContent = 'Choose an operations tool above.';
    if (copy) copy.classList.add('hidden');
  };
}
