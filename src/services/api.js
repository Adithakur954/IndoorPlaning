export async function api(url, options = {}) {
  const response = await fetch(`/api${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    if (response.status === 402) window.dispatchEvent(new Event("license-required"));
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
