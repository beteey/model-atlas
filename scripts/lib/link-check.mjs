const RESTRICTED = new Set([401, 402, 403, 407, 423, 429, 451]);

// An HTTP failure is not evidence that an article was removed. Only explicit
// not-found/gone responses enter the suspected-dead-link report.
export function classifyStatus(status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new TypeError('Invalid HTTP status');
  if (status >= 200 && status < 300) return 'available';
  if (status === 404 || status === 410) return 'broken';
  if (RESTRICTED.has(status)) return 'blocked';
  return 'unknown';
}

export async function probeLink(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError('Invalid source URL');
  if (typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new TypeError('Invalid link probe options');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 model-atlas-linkcheck' } });
  } catch (error) {
    if (controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) return { status: 'timeout', category: 'unknown' };
    if (error instanceof TypeError && error.message === 'fetch failed') return { status: 'network-error', category: 'unknown' };
    throw error;
  } finally { clearTimeout(timer); }
  const category = classifyStatus(response.status);
  // We test the HTTP response, not article contents; do not download the body.
  await response.body?.cancel();
  return { status: response.status, category };
}
