import {
  balanceEventIndex,
  balancePercent,
  deepseekPricingTier,
  parseBalanceResult,
  resetInText,
  urgentWindow,
  type BalanceState,
  type RawBalanceResult,
} from '../client/balance';
import { DRAG_THRESHOLD, HIT_BOX, PET_REF_WIDTH } from '../client/constants';
import type { ClientConfig, Pet } from '../client/types';
import { pick, pickCategoryAction, randomBetween, rollKind } from '../shared/pet-engine';
import { windowOriginRange } from './bounds';

interface DesktopRuntime {
  assetBase: string;
}

interface WindowMetrics {
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

interface DesktopApi {
  runtime(): Promise<DesktopRuntime>;
  request<T>(kind: 'snapshot' | 'balance' | 'turn-spend' | 'balance-trigger', sessionId?: string): Promise<T>;
  metrics(): Promise<WindowMetrics>;
  setInteractive(interactive: boolean): void;
  setWindowPosition(x: number, y: number): void;
  ready(): void;
}

interface Snapshot {
  config: ClientConfig;
  sessionId: string | null;
}

interface TurnSpendResponse {
  count: number;
  amount: number;
  currency: string;
  at: number;
}

declare global {
  interface Window {
    dshPetDesktop: DesktopApi;
  }
}

const api = window.dshPetDesktop;
const params = new URLSearchParams(location.search);
const petId = params.get('petId') ?? '';
function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('desktop renderer DOM incomplete: ' + selector);
  return element;
}
const videoA = requiredElement<HTMLVideoElement>('#video-a');
const videoB = requiredElement<HTMLVideoElement>('#video-b');
const hit = requiredElement<HTMLDivElement>('#hit');
const balanceBubble = requiredElement<HTMLDivElement>('#balance');
const spendBubble = requiredElement<HTMLDivElement>('#spend');

let assetBase = '';
let config: ClientConfig | undefined;
let pet: Pet | undefined;
let sessionId: string | undefined;
let currentAnim = '';
let facing: 'left' | 'right' = 'left';
let front = 0;
let generation = 0;
let hovering = false;
let balance: BalanceState | undefined;
let previousBalanceIndex = -1;
let previousSpendCount = -1;
let previousTriggerCount = -1;
let spendTimer: number | undefined;
let balanceTimer: number | undefined;
let moveFrame: number | undefined;
let moveGeneration = 0;

interface PendingMove {
  startX: number;
  targetX: number;
  y: number;
  leadSec: number;
  tailSec: number;
}

let pendingMove: PendingMove | undefined;

const animationUrl = (name: string): string => assetBase + '/thumb/' + encodeURIComponent(name) + '.webm';

function applyPet(next: Pet): void {
  pet = next;
  const size = next.size;
  document.documentElement.style.setProperty('--pet-size', size + 'px');
  document.documentElement.style.setProperty('--video-height', (size * 9) / 16 + 'px');
  hit.style.left = (HIT_BOX.x0 / 640) * 100 + '%';
  hit.style.top = (HIT_BOX.y0 / 360) * 100 + '%';
  hit.style.width = ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + '%';
  hit.style.height = ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + '%';
}

function setFacing(next: 'left' | 'right'): void {
  facing = next;
  const transform = facing === 'right' ? 'scaleX(-1)' : '';
  videoA.style.transform = transform;
  videoB.style.transform = transform;
}

function stopMove(): void {
  pendingMove = undefined;
  moveGeneration += 1;
  if (moveFrame !== undefined) cancelAnimationFrame(moveFrame);
  moveFrame = undefined;
}

function driveMove(video: HTMLVideoElement): void {
  const move = pendingMove;
  if (!move || moveFrame !== undefined) return;
  pendingMove = undefined;
  const token = ++moveGeneration;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 10.09;
  const travelWindow = Math.max(0.1, duration - move.leadSec - move.tailSec);
  const step = () => {
    if (token !== moveGeneration) return;
    const time = video.currentTime || 0;
    let ratio = 0;
    if (time >= duration - move.tailSec) ratio = 1;
    else if (time > move.leadSec) ratio = (time - move.leadSec) / travelWindow;
    api.setWindowPosition(move.startX + (move.targetX - move.startX) * ratio, move.y);
    if (ratio < 1) moveFrame = requestAnimationFrame(step);
    else moveFrame = undefined;
  };
  moveFrame = requestAnimationFrame(step);
}

function switchTo(name: string, once = true): void {
  if (!name || !assetBase) return;
  currentAnim = name;
  const token = ++generation;
  const target = front === 0 ? videoB : videoA;
  const old = front === 0 ? videoA : videoB;
  target.src = animationUrl(name);
  target.loop = !once;
  target.muted = true;
  target.autoplay = true;
  target.playsInline = true;
  target.onended = once ? () => void handleEnded(target) : null;
  const ready = () => {
    target.removeEventListener('loadeddata', ready);
    if (token !== generation) return;
    target.classList.add('front');
    old.classList.remove('front');
    old.onended = null;
    old.pause();
    front = front === 0 ? 1 : 0;
    setFacing(facing);
    void target.play().catch(() => {});
    driveMove(target);
  };
  target.addEventListener('loadeddata', ready);
  target.onerror = () => console.error('[dsh-pet-desktop] animation failed:', name);
  target.load();
  if (target.readyState >= 2) ready();
}

async function tryMove(): Promise<boolean | string> {
  if (!config || !pet || pendingMove || moveFrame !== undefined) return true;
  const actions = config.animations.moves.actions;
  if (actions.length === 0) return false;
  const action = pick(actions);
  const options = { ...config.animations.moves.default, ...(action.params ?? {}) };
  const direction: 1 | -1 = (facing === 'right') !== config.animations.turn.includes(currentAnim) ? 1 : -1;
  const metrics = await api.metrics();
  const distance = randomBetween(options.minDist, options.maxDist) * (pet.size / PET_REF_WIDTH);
  const targetX = metrics.bounds.x + direction * distance;
  const range = windowOriginRange(metrics.workArea, pet.size, options.margin);
  if (targetX < range.minX || targetX > range.maxX) return false;
  pendingMove = {
    startX: metrics.bounds.x,
    targetX,
    y: metrics.bounds.y,
    leadSec: options.leadSec,
    tailSec: options.tailSec,
  };
  switchTo(action.name, true);
  return action.name;
}

async function pickNext(): Promise<void> {
  if (!config) return;
  const kind = rollKind(Math.random(), config.animationWeights);
  if (kind === 'idle') switchTo(pick(config.animations.idle, currentAnim), true);
  else if (kind === 'turn') switchTo(pick(config.animations.turn, currentAnim), true);
  else if (kind === 'move') {
    const moved = await tryMove();
    if (moved === false) {
      switchTo(
        pickCategoryAction(config.animations.categories, config.animations.idle, facing, currentAnim).name,
        true,
      );
    }
  } else {
    switchTo(pickCategoryAction(config.animations.categories, config.animations.idle, facing, currentAnim).name, true);
  }
}

function handleEnded(video: HTMLVideoElement): void {
  if (!video.classList.contains('front') || !config || drag.active) return;
  const isEvent = Object.values(config.animations.events).some((pool) => pool.includes(currentAnim));
  if (isEvent || config.animations.drag.includes(currentAnim) || config.animations.clicks.includes(currentAnim)) {
    switchTo(pick(config.animations.idle, currentAnim), true);
    return;
  }
  if (config.animations.turn.includes(currentAnim)) setFacing(facing === 'left' ? 'right' : 'left');
  void pickNext();
}

function showBalance(duration?: number): void {
  balanceBubble.classList.add('on');
  if (balanceTimer !== undefined) window.clearTimeout(balanceTimer);
  if (duration !== undefined) balanceTimer = window.setTimeout(() => balanceBubble.classList.remove('on'), duration);
}

function hideBalance(): void {
  if (balanceTimer !== undefined) window.clearTimeout(balanceTimer);
  balanceTimer = undefined;
  balanceBubble.classList.remove('on');
}

function renderBalance(state: BalanceState): void {
  if (!state.ok) {
    const text =
      state.reason === 'unsupported'
        ? '当前服务商暂不支持余额查询'
        : state.reason === 'credential-missing'
          ? '缺少凭证：' + (state.message ?? '')
          : '余额查询失败';
    balanceBubble.innerHTML = '<div class="error"></div>';
    const node = balanceBubble.querySelector<HTMLDivElement>('.error');
    if (node) node.textContent = text;
    return;
  }
  if (state.kind === 'opencode') {
    const windowUsage = urgentWindow(state);
    balanceBubble.replaceChildren();
    const row = document.createElement('div');
    row.textContent = windowUsage
      ? windowUsage.label + '额度已用 ' + Math.round(windowUsage.percent) + '%'
      : '额度数据不可用';
    balanceBubble.append(row);
    if (windowUsage) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      const reset = resetInText(windowUsage.resetsAt);
      sub.textContent = reset ? reset + '重置' : '已重置';
      balanceBubble.append(sub);
    }
    return;
  }
  const tier = deepseekPricingTier();
  balanceBubble.replaceChildren();
  const row = document.createElement('div');
  row.append('余额 ');
  const value = document.createElement('span');
  value.className = 'balance-value';
  value.textContent = (state.currency || '¥') + (state.total ?? '-');
  row.append(value);
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.append('当前时段：');
  const tierNode = document.createElement('span');
  tierNode.className = tier;
  tierNode.textContent = tier === 'peak' ? '梁文峰' : '梁文谷';
  sub.append(tierNode);
  balanceBubble.append(row, sub);
}

async function refreshBalance(): Promise<void> {
  if (!config || !pet?.balanceEnabled || !sessionId) return;
  try {
    balance = parseBalanceResult(await api.request<RawBalanceResult>('balance', sessionId));
    renderBalance(balance);
    if (!balance.ok) {
      showBalance(10_000);
      return;
    }
    const percent = balancePercent(balance, config.deepseekFullBalanceCny);
    if (percent === undefined) return;
    const index = balanceEventIndex(percent);
    if (index === previousBalanceIndex) return;
    previousBalanceIndex = index;
    const animation = config.animations.events.balance?.[index];
    if (!animation) return;
    stopMove();
    showBalance(10_000);
    switchTo(animation, true);
  } catch (error) {
    console.warn('[dsh-pet-desktop] balance failed', error);
  }
}

function showSpend(data: TurnSpendResponse): void {
  const amount =
    data.amount >= 0.01 ? data.amount.toFixed(2) : data.amount >= 0.0001 ? data.amount.toFixed(4) : '<0.0001';
  spendBubble.replaceChildren();
  const label = document.createElement('div');
  label.className = 'spend-label';
  label.textContent = '本轮消耗';
  const value = document.createElement('div');
  value.className = 'spend-value';
  value.textContent = (data.currency || 'CNY') + ' ' + amount;
  spendBubble.append(label, value);
  spendBubble.classList.add('on');
  if (spendTimer !== undefined) window.clearTimeout(spendTimer);
  spendTimer = window.setTimeout(() => spendBubble.classList.remove('on'), 5_000);
}

async function applySnapshot(snapshot: Snapshot): Promise<void> {
  config = snapshot.config;
  const nextPet = config.pets.find((item) => item.id === petId);
  if (!nextPet) return;
  applyPet(nextPet);
  const nextSession = snapshot.sessionId || undefined;
  if (nextSession !== sessionId) {
    sessionId = nextSession;
    balance = undefined;
    previousBalanceIndex = -1;
    previousSpendCount = -1;
    previousTriggerCount = -1;
    hideBalance();
    spendBubble.classList.remove('on');
    if (sessionId && nextPet.balanceEnabled) await refreshBalance();
  }
  if (!currentAnim) switchTo(config.animations.idle[0] ?? '', true);
}

async function snapshotLoop(): Promise<void> {
  try {
    await applySnapshot(await api.request<Snapshot>('snapshot'));
  } catch (error) {
    console.warn('[dsh-pet-desktop] snapshot failed', error);
  } finally {
    window.setTimeout(() => void snapshotLoop(), 2_000);
  }
}

async function balanceLoop(): Promise<void> {
  if (sessionId && pet?.balanceEnabled) await refreshBalance();
  const seconds = config?.eventsRefreshSec.balance ?? 180;
  window.setTimeout(() => void balanceLoop(), Math.max(1_000, seconds * 1_000));
}

async function spendLoop(): Promise<void> {
  if (sessionId && pet?.balanceEnabled) {
    try {
      const data = await api.request<TurnSpendResponse>('turn-spend', sessionId);
      if (previousSpendCount < 0) previousSpendCount = data.count;
      else if (data.count !== previousSpendCount) {
        previousSpendCount = data.count;
        if (data.amount > 0) showSpend(data);
      }
    } catch {
      // 下一轮重试。
    }
  }
  window.setTimeout(() => void spendLoop(), 2_000);
}

async function triggerLoop(): Promise<void> {
  if (sessionId && pet?.balanceEnabled) {
    try {
      const data = await api.request<{ count: number }>('balance-trigger', sessionId);
      if (previousTriggerCount < 0) previousTriggerCount = data.count;
      else if (data.count !== previousTriggerCount) {
        previousTriggerCount = data.count;
        await refreshBalance();
      }
    } catch {
      // 下一轮重试。
    }
  }
  window.setTimeout(() => void triggerLoop(), 1_000);
}

const drag = {
  active: false,
  dragging: false,
  ready: false,
  pointerId: 0,
  screenX: 0,
  screenY: 0,
  windowX: 0,
  windowY: 0,
};
let justDragged = false;

hit.addEventListener('mouseenter', () => {
  hovering = true;
  api.setInteractive(true);
  spendBubble.classList.remove('on');
  if (balance) {
    renderBalance(balance);
    showBalance();
  }
  void refreshBalance().then(() => {
    if (hovering && balance) showBalance();
  });
});
hit.addEventListener('mouseleave', () => {
  hovering = false;
  if (!drag.active) api.setInteractive(false);
  hideBalance();
});
hit.addEventListener('pointerdown', (event) => {
  stopMove();
  drag.active = true;
  drag.dragging = false;
  drag.ready = false;
  drag.pointerId = event.pointerId;
  drag.screenX = event.screenX;
  drag.screenY = event.screenY;
  hit.classList.add('dragging');
  hit.setPointerCapture(event.pointerId);
  api.setInteractive(true);
  void api.metrics().then((metrics) => {
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    drag.windowX = metrics.bounds.x;
    drag.windowY = metrics.bounds.y;
    drag.ready = true;
  });
});
hit.addEventListener('pointermove', (event) => {
  if (!drag.active || !drag.ready || event.pointerId !== drag.pointerId) return;
  const dx = event.screenX - drag.screenX;
  const dy = event.screenY - drag.screenY;
  if (!drag.dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
    drag.dragging = true;
    if (config?.animations.drag.length) switchTo(pick(config.animations.drag), true);
  }
  if (drag.dragging) api.setWindowPosition(drag.windowX + dx, drag.windowY + dy);
});

function finishDrag(event: PointerEvent): void {
  if (!drag.active || event.pointerId !== drag.pointerId) return;
  const wasDragging = drag.dragging;
  drag.active = false;
  drag.dragging = false;
  drag.ready = false;
  hit.classList.remove('dragging');
  try {
    hit.releasePointerCapture(event.pointerId);
  } catch {
    // 捕获可能已由系统释放。
  }
  if (wasDragging) {
    justDragged = true;
    window.setTimeout(() => (justDragged = false), 100);
    if (config?.animations.idle.length) switchTo(pick(config.animations.idle, currentAnim), true);
  }
  if (!hovering) api.setInteractive(false);
}

hit.addEventListener('pointerup', finishDrag);
hit.addEventListener('pointercancel', finishDrag);
hit.addEventListener('click', () => {
  if (drag.active || justDragged || !config) return;
  stopMove();
  void refreshBalance();
  if (config.animations.clicks.length) switchTo(pick(config.animations.clicks), true);
});
document.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('beforeunload', () => api.setInteractive(false));

void (async () => {
  const runtime = await api.runtime();
  assetBase = runtime.assetBase;
  await applySnapshot(await api.request<Snapshot>('snapshot'));
  api.ready();
  void snapshotLoop();
  void balanceLoop();
  void spendLoop();
  void triggerLoop();
})().catch((error) => console.error('[dsh-pet-desktop] initialization failed', error));
