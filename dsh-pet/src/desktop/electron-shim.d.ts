/* Electron 正式类型由 desktop 子包提供；此最小声明让主插件无需安装 Electron 也能 typecheck。 */
declare module 'electron' {
  export interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
  }
  export interface Display {
    workArea: Rectangle;
  }
  export interface WebContents {
    send(channel: string, ...args: unknown[]): void;
    on(event: string, listener: (event: { preventDefault(): void }, url: string) => void): void;
    setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  }
  export class BrowserWindow {
    constructor(options: Record<string, unknown>);
    static fromWebContents(contents: WebContents): BrowserWindow | null;
    static getAllWindows(): BrowserWindow[];
    readonly webContents: WebContents;
    loadFile(path: string, options?: { query?: Record<string, string> }): Promise<void>;
    once(event: string, listener: (...args: unknown[]) => void): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    showInactive(): void;
    close(): void;
    isDestroyed(): boolean;
    getBounds(): Rectangle;
    setBounds(bounds: Partial<Rectangle>, animate?: boolean): void;
    setPosition(x: number, y: number, animate?: boolean): void;
    setAlwaysOnTop(flag: boolean, level?: string): void;
    setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  }
  export const app: {
    requestSingleInstanceLock(): boolean;
    quit(): void;
    whenReady(): Promise<void>;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
  export const screen: {
    getPrimaryDisplay(): Display;
    getDisplayMatching(rectangle: Rectangle): Display;
  };
  export const ipcMain: {
    handle(channel: string, listener: (event: { sender: WebContents }, payload?: unknown) => unknown): void;
    on(channel: string, listener: (event: { sender: WebContents }, payload?: unknown) => void): void;
  };
  export const contextBridge: {
    exposeInMainWorld(key: string, value: unknown): void;
  };
  export const ipcRenderer: {
    invoke(channel: string, payload?: unknown): Promise<unknown>;
    send(channel: string, payload?: unknown): void;
  };
}
