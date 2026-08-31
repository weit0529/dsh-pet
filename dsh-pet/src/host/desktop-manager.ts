import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type DesktopProcessState = 'unavailable' | 'stopped' | 'starting' | 'running' | 'error';

export interface DesktopLaunch {
  command: string;
  args: string[];
  cwd: string;
  runtime: 'installed' | 'development' | 'environment';
}

export interface DesktopStatus {
  configured: boolean;
  available: boolean;
  state: DesktopProcessState;
  runtime?: DesktopLaunch['runtime'];
  pid?: number;
  message: string;
}

interface DesktopManagerOptions {
  packageRoot: string;
  userRoot: string;
  origin: string;
  token: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * 查找顺序：显式环境变量 → DSH 用户目录中的正式安装版 → 仓库构建产物 → 仓库开发版 Electron。
 * 返回值不向 Web 暴露绝对路径，只在 Host 内部用于 spawn。
 */
export function resolveDesktopLaunch(options: DesktopManagerOptions): DesktopLaunch | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return undefined;
  const env = options.env ?? process.env;
  const explicit = env.DSH_PET_DESKTOP_PATH?.trim();
  if (explicit) {
    const command = isAbsolute(explicit) ? explicit : resolve(explicit);
    if (existsSync(command)) return { command, args: [], cwd: dirname(command), runtime: 'environment' };
  }

  const installed = join(options.userRoot, 'desktop', 'dsh-pet-desktop.exe');
  if (existsSync(installed)) return { command: installed, args: [], cwd: dirname(installed), runtime: 'installed' };

  const desktopRoot = join(options.packageRoot, 'desktop');
  for (const executable of [join(desktopRoot, 'dist', 'win-unpacked', 'dsh-pet-desktop.exe')]) {
    if (existsSync(executable)) {
      return { command: executable, args: [], cwd: dirname(executable), runtime: 'development' };
    }
  }
  const electron = join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (existsSync(electron)) {
    return { command: electron, args: [desktopRoot], cwd: desktopRoot, runtime: 'development' };
  }
  return undefined;
}

export class DesktopManager {
  private child?: ChildProcess;
  private desired: boolean;
  private disposed: boolean;
  private state: DesktopProcessState;
  private message: string;
  private runtime?: DesktopLaunch['runtime'];
  private restartTimer?: NodeJS.Timeout;
  private readyTimer?: NodeJS.Timeout;
  private restartTimes: number[];
  private readonly options: DesktopManagerOptions;

  constructor(options: DesktopManagerOptions) {
    this.options = options;
    this.desired = false;
    this.disposed = false;
    this.state = 'stopped';
    this.message = '桌面显示未启用';
    this.restartTimes = [];
  }

  status(): DesktopStatus {
    const launch = resolveDesktopLaunch(this.options);
    const available = launch !== undefined;
    const state = !available && !this.child ? 'unavailable' : this.state;
    return {
      configured: this.desired,
      available,
      state,
      runtime: this.runtime ?? launch?.runtime,
      pid: this.child?.pid,
      message: !available && !this.child ? '未安装 Windows 桌面伴生组件' : this.message,
    };
  }

  canStart(): boolean {
    return resolveDesktopLaunch(this.options) !== undefined;
  }

  reconcile(enabled: boolean): DesktopStatus {
    this.desired = enabled;
    if (!enabled) {
      this.stop('桌面显示已关闭');
      return this.status();
    }
    if (this.child) return this.status();
    this.start();
    return this.status();
  }

  /** Electron 渲染器完成首屏加载后由受令牌保护的 ready 端点确认。 */
  markReady(): DesktopStatus {
    if (this.child && this.desired) {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      this.state = 'running';
      this.message = '桌面组件已运行';
    }
    return this.status();
  }

  private start(): void {
    if (this.disposed || !this.desired || this.child) return;
    const launch = resolveDesktopLaunch(this.options);
    if (!launch) {
      this.state = 'unavailable';
      this.message = '未安装 Windows 桌面伴生组件';
      return;
    }
    this.runtime = launch.runtime;
    this.state = 'starting';
    this.message = '桌面组件正在启动';
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_PET_HOST_ORIGIN: this.options.origin,
        DSH_PET_DESKTOP_TOKEN: this.options.token,
      },
    });
    this.child = child;
    child.stdout?.on('data', (chunk) => console.log('[dsh-pet/desktop] ' + String(chunk).trimEnd()));
    child.stderr?.on('data', (chunk) => console.warn('[dsh-pet/desktop] ' + String(chunk).trimEnd()));
    child.once('spawn', () => {
      if (this.child !== child) return;
      this.state = 'starting';
      this.message = '桌面进程已启动，正在加载宠物窗口';
      this.readyTimer = setTimeout(() => {
        if (this.child !== child || this.state !== 'starting') return;
        this.state = 'error';
        this.message = '桌面进程已启动，但宠物窗口未能完成加载';
        child.kill();
      }, 15_000);
      console.log('[dsh-pet] desktop companion started pid=' + String(child.pid ?? 'unknown'));
    });
    child.once('error', (error) => {
      if (this.child !== child) return;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      this.child = undefined;
      this.state = 'error';
      this.message = '桌面组件启动失败：' + error.message;
      this.scheduleRestart();
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      this.child = undefined;
      if (!this.desired || this.disposed) {
        this.state = 'stopped';
        this.message = '桌面组件已停止';
        return;
      }
      this.state = 'error';
      this.message = '桌面组件异常退出（' + (signal ?? code ?? 'unknown') + '）';
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (!this.desired || this.disposed || this.restartTimer) return;
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((at) => now - at < 60_000);
    if (this.restartTimes.length >= 3) {
      this.message += '，一分钟内已停止自动重试';
      return;
    }
    this.restartTimes.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, 2_000 * this.restartTimes.length);
  }

  private stop(message: string): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill();
    this.state = 'stopped';
    this.message = message;
  }

  dispose(): void {
    this.disposed = true;
    this.desired = false;
    this.stop('DSH 已停止，桌面组件已退出');
  }
}
