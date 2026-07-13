// Dashboard tools are intentionally open. Keep the existing helper name so the
// rest of app.js does not need credential-specific branches.
window.adminJson = async function adminJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
};
