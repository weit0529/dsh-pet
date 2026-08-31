/** 桌面窗口的活动会话选择：最后聚焦的 Web 页面优先，最近 Host 事件兜底。 */

interface ClientHeartbeat {
  sessionId?: string;
  focused: boolean;
  at: number;
}

export class DesktopSessionTracker {
  private readonly clients: Map<string, ClientHeartbeat>;
  private lastEvent?: { sessionId: string; at: number };
  private readonly staleMs: number;

  constructor(staleMs = 12_000) {
    this.clients = new Map<string, ClientHeartbeat>();
    this.staleMs = staleMs;
  }

  heartbeat(input: { clientId: string; sessionId?: string; focused: boolean }, now = Date.now()): void {
    this.clients.delete(input.clientId);
    this.clients.set(input.clientId, { sessionId: input.sessionId, focused: input.focused, at: now });
    this.trim(now);
  }

  sessionEvent(sessionId: string, now = Date.now()): void {
    this.lastEvent = { sessionId, at: now };
  }

  current(now = Date.now()): string | undefined {
    this.trim(now);
    const recent = [...this.clients.values()].sort((a, b) => b.at - a.at);
    return (
      recent.find((item) => item.focused && item.sessionId)?.sessionId ??
      recent.find((item) => item.sessionId)?.sessionId ??
      this.lastEvent?.sessionId
    );
  }

  private trim(now: number): void {
    for (const [clientId, item] of this.clients) {
      if (now - item.at > this.staleMs) this.clients.delete(clientId);
    }
    while (this.clients.size > 32) this.clients.delete(this.clients.keys().next().value as string);
  }
}
