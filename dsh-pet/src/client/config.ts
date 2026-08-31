// 配置层：剥注释、校验 config.jsonc。运行时（ANIM）直接使用与 jsonc 同构的 ClientConfig，
// 不做字段转换；缺失/非法一律视为配置错误（throw，由加载层显式报错）。
import type { Animations, ClientConfig, Corner, Pet, Weights } from './types';

/** 剥除 JSONC 注释（行注释 // 与块注释），得到纯 JSON 字符串 */
export const stripJsonc = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

/** 支持的角落白名单 */
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
/** corner 合法性检查用的 string 集合（Corner[] 的 includes 要求 Corner 参数，无法接收未知 string） */
const CORNER_SET: ReadonlySet<string> = new Set(CORNERS);

/** ClientConfig 类型占位（data-less；PetMulti 加载后由 assertClientConfig 赋真实值） */
export const EMPTY_CONF: ClientConfig = {
  desktopEnabled: false,
  notificationsEnabled: true,
  pets: [],
  animations: {
    idle: [],
    turn: [],
    drag: [],
    clicks: [],
    moves: { default: {}, actions: [] },
    categories: [],
    events: {},
  },
  animationWeights: { idle: 0, turn: 0, move: 0 },
  eventsRefreshSec: {},
  deepseekFullBalanceCny: 20,
};

/** 校验 config.jsonc 解析结果并返回 ClientConfig；任一字段缺失/非法即视为配置错误抛出 */
export function assertClientConfig(raw: unknown): ClientConfig {
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: config 非对象');
  // raw 是 unknown 输入（jsonc 解析产物），按 Record 读取后逐字段手工校验，字段读写无法静态定型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = raw as Record<string, any>;

  // ---- pets ----
  const petsArr = cfg.pets;
  if (!Array.isArray(petsArr) || !petsArr.length) throw new Error('dsh-pet: 缺少 pets');
  const seen = new Set<string>();
  const pets: Pet[] = [];
  for (const p of petsArr) {
    const id = String(p?.id ?? '');
    // eslint-disable-next-line no-control-regex -- match host-side path/control-character validation
    if (!id || id.length > 64 || /[\\/:*?"<>|\x00-\x1f]/.test(id) || seen.has(id)) {
      throw new Error('dsh-pet: pet id 非法或重复「' + id + '」');
    }
    const size = Number(p?.size);
    if (!Number.isFinite(size) || size < 120 || size > 2000) {
      throw new Error('dsh-pet: pet「' + id + '」大小非法（需在 120–2000px）');
    }
    const balanceEnabled = p?.balanceEnabled;
    if (typeof balanceEnabled !== 'boolean')
      throw new Error('dsh-pet: pet「' + id + '」缺少 balanceEnabled（需为布尔值 true/false）');
    const corner = p?.position?.corner;
    if (typeof corner !== 'string' || !CORNER_SET.has(corner)) throw new Error('dsh-pet: pet「' + id + '」corner 非法');
    const marginX = Number(p?.position?.marginX);
    const marginY = Number(p?.position?.marginY);
    if (
      !Number.isFinite(marginX) ||
      !Number.isFinite(marginY) ||
      Math.abs(marginX) > 100_000 ||
      Math.abs(marginY) > 100_000
    ) {
      throw new Error('dsh-pet: pet「' + id + '」边距非法');
    }
    seen.add(id);
    pets.push({ id, size, balanceEnabled, position: { corner: corner as Corner, marginX, marginY } });
  }

  // ---- animations ----
  const rawAnimations = cfg.animations;
  if (!rawAnimations || typeof rawAnimations !== 'object') throw new Error('dsh-pet: 缺少 animations');
  const stringPool = (value: unknown, label: string, allowEmpty: boolean): string[] => {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
      throw new Error('dsh-pet: ' + label + ' 必须是' + (allowEmpty ? '' : '非空') + '动画名数组');
    }
    if (value.some((name) => typeof name !== 'string' || name.trim().length === 0)) {
      throw new Error('dsh-pet: ' + label + ' 含非法动画名');
    }
    return value.map((name) => String(name));
  };
  const idle = stringPool(rawAnimations.idle, 'animations.idle', false);
  const turn = stringPool(rawAnimations.turn, 'animations.turn', true);
  const drag = stringPool(rawAnimations.drag, 'animations.drag', true);
  const clicks = stringPool(rawAnimations.clicks, 'animations.clicks', true);

  const rawMoves = rawAnimations.moves;
  if (
    !rawMoves ||
    typeof rawMoves !== 'object' ||
    !rawMoves.default ||
    typeof rawMoves.default !== 'object' ||
    !Array.isArray(rawMoves.actions)
  ) {
    throw new Error('dsh-pet: animations.moves 结构非法');
  }
  const moveDefaults: Record<string, number> = {};
  for (const key of ['minDist', 'maxDist', 'margin', 'leadSec', 'tailSec']) {
    const n = Number(rawMoves.default[key]);
    if (!Number.isFinite(n) || n < 0) throw new Error('dsh-pet: animations.moves.default.' + key + ' 非法');
    moveDefaults[key] = n;
  }
  if (moveDefaults.maxDist < moveDefaults.minDist) {
    throw new Error('dsh-pet: animations.moves.default.maxDist 不能小于 minDist');
  }
  const moveActions = rawMoves.actions.map((action: unknown, index: number) => {
    if (!action || typeof action !== 'object') throw new Error('dsh-pet: animations.moves.actions[' + index + '] 非法');
    const item = action as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) throw new Error('dsh-pet: animations.moves.actions[' + index + '].name 非法');
    const params: Record<string, number> = {};
    if (item.params !== undefined) {
      if (!item.params || typeof item.params !== 'object' || Array.isArray(item.params)) {
        throw new Error('dsh-pet: animations.moves.actions[' + index + '].params 非法');
      }
      for (const [key, value] of Object.entries(item.params)) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new Error('dsh-pet: 移动参数 ' + key + ' 非法');
        params[key] = n;
      }
    }
    return Object.keys(params).length > 0 ? { name, params } : { name };
  });

  if (!Array.isArray(rawAnimations.categories)) throw new Error('dsh-pet: animations.categories 缺失');
  const categories: Animations['categories'] = rawAnimations.categories.map((category: unknown, index: number) => {
    if (!category || typeof category !== 'object') {
      throw new Error('dsh-pet: animations.categories[' + index + '] 非法');
    }
    const item = category as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const weight = Number(item.weight);
    if (!id || !Number.isFinite(weight) || weight < 0) {
      throw new Error('dsh-pet: animations.categories[' + index + '] id/weight 非法');
    }
    if (item.noMirror !== undefined && typeof item.noMirror !== 'boolean') {
      throw new Error('dsh-pet: animations.categories[' + index + '].noMirror 非法');
    }
    return {
      id,
      weight,
      ...(item.noMirror === true ? { noMirror: true } : {}),
      actions: stringPool(item.actions, 'animations.categories.' + id + '.actions', false),
    };
  });
  if (categories.reduce((sum: number, category: Animations['categories'][number]) => sum + category.weight, 0) <= 0) {
    throw new Error('dsh-pet: animations.categories 权重合计必须大于 0');
  }

  const rawEvents = rawAnimations.events;
  if (!rawEvents || typeof rawEvents !== 'object' || Array.isArray(rawEvents)) {
    throw new Error('dsh-pet: 缺少 animations.events');
  }
  const events: Record<string, string[]> = {};
  for (const [eventName, pool] of Object.entries(rawEvents)) {
    events[eventName] = stringPool(pool, 'animations.events.' + eventName, false);
  }
  if (!events.balance || events.balance.length < 6) {
    throw new Error('dsh-pet: animations.events.balance 至少需要 6 个档位动画');
  }

  const animations: Animations = {
    idle,
    turn,
    drag,
    clicks,
    moves: { default: moveDefaults, actions: moveActions },
    categories,
    events,
  };

  // ---- animationWeights ----
  const rawWeights = cfg.animationWeights;
  if (!rawWeights || typeof rawWeights !== 'object') throw new Error('dsh-pet: 缺少 animationWeights');
  const animationWeights: Weights = {
    idle: Number(rawWeights.idle),
    turn: Number(rawWeights.turn),
    move: Number(rawWeights.move),
  };
  for (const [key, value] of Object.entries(animationWeights)) {
    if (!Number.isFinite(value) || value < 0) throw new Error('dsh-pet: animationWeights.' + key + ' 非法');
  }
  if (animationWeights.turn > 0 && turn.length === 0) {
    throw new Error('dsh-pet: animationWeights.turn 大于 0 时 animations.turn 不能为空');
  }
  if (animationWeights.move > 0 && moveActions.length === 0) {
    throw new Error('dsh-pet: animationWeights.move 大于 0 时 animations.moves.actions 不能为空');
  }
  if (animationWeights.idle + animationWeights.turn + animationWeights.move > 100) {
    throw new Error('dsh-pet: animationWeights 顶层权重合计不能超过 100');
  }

  // ---- eventsRefreshSec（事件刷新周期：事件名 → 正数秒数）----
  // 事件功能已内置：周期段与 balance 周期均为必需，缺失/非法即配置不完整，显式报错
  const ers = cfg.eventsRefreshSec;
  if (!ers || typeof ers !== 'object' || Array.isArray(ers)) throw new Error('dsh-pet: 缺少 eventsRefreshSec');
  const cleaned: Record<string, number> = {};
  for (const [eventName, sec] of Object.entries(ers)) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error('dsh-pet: eventsRefreshSec.' + eventName + ' 非法（需为正数秒）');
    cleaned[eventName] = n;
  }
  const balanceSec = cleaned.balance;
  if (balanceSec === undefined) throw new Error('dsh-pet: eventsRefreshSec.balance 缺失（余额事件周期必备）');

  const deepseekFullBalanceCny = Number(cfg.deepseekFullBalanceCny);
  if (!Number.isFinite(deepseekFullBalanceCny) || deepseekFullBalanceCny <= 0) {
    throw new Error('dsh-pet: deepseekFullBalanceCny 非法（需为正数）');
  }

  // ---- desktopEnabled / notificationsEnabled（全局开关：必填布尔值）----
  const desktopEnabled = cfg.desktopEnabled;
  if (typeof desktopEnabled !== 'boolean') throw new Error('dsh-pet: 缺少 desktopEnabled（需为布尔值 true/false）');
  const notificationsEnabled = cfg.notificationsEnabled;
  if (typeof notificationsEnabled !== 'boolean')
    throw new Error('dsh-pet: 缺少 notificationsEnabled（需为布尔值 true/false）');

  return {
    desktopEnabled,
    notificationsEnabled,
    pets,
    animations,
    animationWeights,
    eventsRefreshSec: cleaned,
    deepseekFullBalanceCny,
  };
}

/** 合并宠物：用户层（{ pets }，与 jsonc 同构）全量替换默认；无用户层回落默认 */
export function resolvePets(defaults: Pet[], user: { pets?: Pet[] }): Pet[] {
  if (user && Array.isArray(user.pets)) return user.pets.length ? user.pets : defaults;
  return defaults;
}

/** 用户覆盖片段（与 jsonc 同构；高级用户直接编辑 main-config.json，缺省字段回落默认） */
export interface UserOverrides {
  pets?: Pet[];
  animations?: Animations;
  animationWeights?: Weights;
  eventsRefreshSec?: Record<string, number>;
  deepseekFullBalanceCny?: number;
  /** 系统通知总开关（可选）：用户层给出时优先于默认配置 */
  notificationsEnabled?: boolean;
  /** 桌面伴生程序开关（可选）。 */
  desktopEnabled?: boolean;
}

/** 合并用户覆盖片段到完全体配置：pets / animations / animationWeights / eventsRefreshSec 有则整体替换，缺省回落默认 */
export function applyUserOverrides(base: ClientConfig, user: UserOverrides): ClientConfig {
  const next: ClientConfig = { ...base, pets: resolvePets(base.pets, user) };
  if (user.animations) next.animations = user.animations;
  if (user.animationWeights) next.animationWeights = user.animationWeights;
  if (user.eventsRefreshSec) next.eventsRefreshSec = user.eventsRefreshSec;
  if (user.deepseekFullBalanceCny !== undefined) next.deepseekFullBalanceCny = user.deepseekFullBalanceCny;
  // 系统通知总开关：用户层显式给出时优先，缺省回落默认配置
  if (user.notificationsEnabled !== undefined) next.notificationsEnabled = user.notificationsEnabled;
  if (user.desktopEnabled !== undefined) next.desktopEnabled = user.desktopEnabled;
  return next;
}
