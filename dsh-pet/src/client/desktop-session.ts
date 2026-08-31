/** Web 页面把“当前会话 + 焦点”作为短时心跳交给 Host，供桌面宠物选会话。 */

export interface SessionListSource {
  getSnapshot(): { current?: unknown };
  subscribe(fn: () => void): () => void;
}

const HEARTBEAT_MS = 4_000;

export function startDesktopSessionHeartbeat(sessionList?: SessionListSource): () => void {
  if (!sessionList || typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const clientId =
    typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let disposed = false;

  const send = (focused = document.visibilityState === 'visible' && document.hasFocus()) => {
    if (disposed) return;
    const current = sessionList.getSnapshot().current;
    const sessionId = typeof current === 'string' && current ? current : null;
    void fetch('/dsh-pet-7340/desktop/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, sessionId, focused, at: Date.now() }),
      keepalive: true,
    }).catch(() => {});
  };

  const onFocus = () => send(true);
  const onBlur = () => send(false);
  const onVisibility = () => send();
  const unsubscribe = sessionList.subscribe(() => send());
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  const timer = window.setInterval(() => send(), HEARTBEAT_MS);
  send();

  return () => {
    send(false);
    disposed = true;
    window.clearInterval(timer);
    unsubscribe();
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
