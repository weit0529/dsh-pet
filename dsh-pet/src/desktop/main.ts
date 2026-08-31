import { app, BrowserWindow, ipcMain, screen, type Rectangle, type WebContents } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientConfig, Pet } from '../client/types';
import { clampWindowOrigin, desktopWindowDimensions, initialWindowOrigin, petVisualOffsets } from './bounds';

// 构建产物位于 desktop/lib/main.js，上一层即独立伴生组件根目录。
const DESKTOP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST_ORIGIN = process.env.DSH_PET_HOST_ORIGIN?.trim() ?? '';
const HOST_TOKEN = process.env.DSH_PET_DESKTOP_TOKEN?.trim() ?? '';
const POLL_MS = 2_000;

interface Snapshot {
  config: ClientConfig;
  sessionId: string | null;
}

interface PetWindow {
  window: BrowserWindow;
  signature: string;
  pet: Pet;
}

const windows = new Map<string, PetWindow>();
let quitting = false;
let pollTimer: NodeJS.Timeout | undefined;
let consecutiveHostFailures = 0;

function validHostOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

async function hostJson<T>(path: string, authorized = false): Promise<T> {
  const response = await fetch(HOST_ORIGIN + '/dsh-pet-7340/' + path, {
    cache: 'no-store',
    headers: authorized ? { authorization: 'Bearer ' + HOST_TOKEN } : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error('Host HTTP ' + response.status + ' for ' + path);
  return (await response.json()) as T;
}

function initialBounds(pet: Pet): Rectangle {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const dim = desktopWindowDimensions(pet.size);
  const origin = initialWindowOrigin(area, pet.size, pet.position.corner, pet.position.marginX, pet.position.marginY);
  return {
    ...origin,
    width: dim.width,
    height: dim.height,
  };
}

function createPetWindow(pet: Pet): PetWindow {
  const bounds = initialBounds(pet);
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(DESKTOP_ROOT, 'lib', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setAlwaysOnTop(true, 'floating');
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => {
    window.setIgnoreMouseEvents(true, { forward: true });
    window.showInactive();
  });
  window.on('closed', () => windows.delete(pet.id));
  void window.loadFile(join(DESKTOP_ROOT, 'renderer.html'), { query: { petId: pet.id } });
  return { window, signature: JSON.stringify(pet), pet };
}

function reconcileWindows(config: ClientConfig): void {
  const ids = new Set(config.pets.map((pet) => pet.id));
  for (const [id, record] of windows) {
    if (!ids.has(id)) {
      windows.delete(id);
      record.window.close();
    }
  }
  for (const pet of config.pets) {
    const signature = JSON.stringify(pet);
    const current = windows.get(pet.id);
    if (!current || current.window.isDestroyed()) {
      windows.set(pet.id, createPetWindow(pet));
      continue;
    }
    current.pet = pet;
    if (current.signature !== signature) {
      current.signature = signature;
      current.window.setBounds(initialBounds(pet), false);
    }
  }
}

async function refresh(): Promise<void> {
  try {
    const snapshot = await hostJson<Snapshot>('desktop/snapshot', true);
    consecutiveHostFailures = 0;
    if (!snapshot.config.desktopEnabled) {
      app.quit();
      return;
    }
    reconcileWindows(snapshot.config);
  } catch (error) {
    consecutiveHostFailures += 1;
    console.warn('[dsh-pet-desktop] snapshot failed', error);
    // DSH 被强制结束时没有机会回收子进程；连续失联后伴生组件自行退出。
    if (consecutiveHostFailures >= 5) app.quit();
  }
}

function browserWindowFor(contents: WebContents): BrowserWindow | null {
  const window = BrowserWindow.fromWebContents(contents);
  return window && !window.isDestroyed() ? window : null;
}

function recordForWindow(window: BrowserWindow): PetWindow | undefined {
  return [...windows.values()].find((record) => record.window === window);
}

function clampPosition(pet: Pet, x: number, y: number): { x: number; y: number } {
  const visual = petVisualOffsets(pet.size);
  const display = screen.getDisplayMatching({
    x: Math.round(x + visual.left),
    y: Math.round(y + visual.top),
    width: Math.max(1, Math.round(visual.right - visual.left)),
    height: Math.max(1, Math.round(visual.bottom - visual.top)),
  });
  const area = display.workArea;
  return clampWindowOrigin(area, pet.size, x, y);
}

function installIpc(): void {
  ipcMain.handle('dsh-pet:runtime', () => ({ assetBase: HOST_ORIGIN + '/dsh-pet-7340' }));
  ipcMain.handle('dsh-pet:request', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') throw new Error('invalid desktop request');
    const record = payload as Record<string, unknown>;
    const kind = String(record.kind ?? '');
    if (kind === 'snapshot') return hostJson<Snapshot>('desktop/snapshot', true);
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
    if (!sessionId || sessionId.length > 256) throw new Error('sessionId required');
    const query = '?sessionId=' + encodeURIComponent(sessionId);
    if (kind === 'balance') return hostJson('balance' + query);
    if (kind === 'turn-spend') return hostJson('turn-spend' + query);
    if (kind === 'balance-trigger') return hostJson('balance/trigger' + query);
    throw new Error('unsupported desktop request');
  });
  ipcMain.handle('dsh-pet:window-metrics', (event) => {
    const window = browserWindowFor(event.sender);
    if (!window) throw new Error('desktop window unavailable');
    const bounds = window.getBounds();
    const record = recordForWindow(window);
    const visual = record ? petVisualOffsets(record.pet.size) : undefined;
    const displayBounds = visual
      ? {
          x: Math.round(bounds.x + visual.left),
          y: Math.round(bounds.y + visual.top),
          width: Math.max(1, Math.round(visual.right - visual.left)),
          height: Math.max(1, Math.round(visual.bottom - visual.top)),
        }
      : bounds;
    return { bounds, workArea: screen.getDisplayMatching(displayBounds).workArea };
  });
  ipcMain.on('dsh-pet:set-interactive', (event, payload) => {
    const window = browserWindowFor(event.sender);
    if (window) window.setIgnoreMouseEvents(payload !== true, { forward: true });
  });
  ipcMain.on('dsh-pet:set-window-position', (event, payload) => {
    const window = browserWindowFor(event.sender);
    if (!window || !payload || typeof payload !== 'object') return;
    const record = payload as Record<string, unknown>;
    const x = Number(record.x);
    const y = Number(record.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const petWindow = recordForWindow(window);
    if (!petWindow) return;
    const next = clampPosition(petWindow.pet, x, y);
    window.setPosition(next.x, next.y, false);
  });
  ipcMain.on('dsh-pet:renderer-ready', (event) => {
    const window = browserWindowFor(event.sender);
    if (window) {
      console.log('[dsh-pet-desktop] renderer ready');
      void fetch(HOST_ORIGIN + '/dsh-pet-7340/desktop/ready', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + HOST_TOKEN },
        signal: AbortSignal.timeout(5_000),
      }).catch((error) => console.warn('[dsh-pet-desktop] ready callback failed', error));
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (!validHostOrigin(HOST_ORIGIN) || HOST_TOKEN.length < 32) {
  console.error('[dsh-pet-desktop] missing or unsafe Host connection settings');
  app.quit();
} else {
  app.on('before-quit', () => {
    quitting = true;
    if (pollTimer) clearTimeout(pollTimer);
  });
  app.on('window-all-closed', () => {
    if (!quitting) app.quit();
  });
  void app.whenReady().then(async () => {
    installIpc();
    const loop = async () => {
      await refresh();
      if (!quitting) pollTimer = setTimeout(() => void loop(), POLL_MS);
    };
    await loop();
  });
}
