/**
 * Web overlay 与桌面伴生程序共用的纯桌宠引擎。
 *
 * 这里只放不依赖 React / DOM / Electron 的选择与移动计算，保证两种显示方式
 * 使用完全相同的动作权重、镜像过滤和移动距离规则。
 */

export interface EngineCategory {
  id: string;
  weight: number;
  noMirror?: boolean;
  actions: string[];
}

export interface EngineWeights {
  idle: number;
  turn: number;
  move: number;
}

/** 从池中等概率抽取；排除后为空时回退原池。 */
export const pick = <T>(pool: T[], exclude?: T): T => {
  const entries = exclude === undefined ? pool : pool.filter((entry) => entry !== exclude);
  const source = entries.length > 0 ? entries : pool;
  return source[Math.floor(Math.random() * source.length)];
};

/** 生成 [min, max) 区间内的随机整数。 */
export const randomBetween = (min: number, max: number): number => Math.floor(min + Math.random() * (max - min));

export const pickWeightedCategory = <T extends EngineCategory>(categories: T[], facing: string): T | null => {
  const populated = categories.filter((category) => category.actions.length > 0);
  if (populated.length === 0) return null;
  const mirrored = populated.filter((category) => !(category.noMirror && facing === 'right'));
  const eligible = mirrored.length > 0 ? mirrored : populated;
  const total = eligible.reduce((sum, category) => sum + category.weight, 0) || 1;
  let cursor = Math.random() * total;
  for (const category of eligible) {
    cursor -= category.weight;
    if (cursor <= 0) return category;
  }
  return eligible[eligible.length - 1];
};

export type RollKind = 'idle' | 'turn' | 'move' | 'action';

export const rollKind = (roll: number, weights: EngineWeights): RollKind => {
  if (roll < weights.idle / 100) return 'idle';
  if (roll < (weights.idle + weights.turn) / 100) return 'turn';
  if (roll < (weights.idle + weights.turn + weights.move) / 100) return 'move';
  return 'action';
};

export const pickCategoryAction = <T extends EngineCategory>(
  categories: T[],
  idlePool: string[],
  facing: string,
  current: string,
): { id: string; name: string } => {
  const category = pickWeightedCategory(categories, facing);
  if (!category) return { id: 'FALLBACK', name: pick(idlePool, current) };
  return { id: category.id, name: pick(category.actions, current) };
};

export interface MovePlan {
  startRatio: number;
  startYRatio: number;
  targetRatio: number;
  totalRatio: number;
}

/** Web 视口中的移动计算；桌面端复用同样的边界规则换算原生窗口坐标。 */
export const planMove = (options: {
  cx: number;
  cy: number;
  W: number;
  H: number;
  dir: 1 | -1;
  minDist: number;
  maxDist: number;
  margin: number;
  halfW: number;
}): MovePlan | null => {
  const distance = randomBetween(options.minDist, options.maxDist);
  const target = options.cx + options.dir * distance;
  const leftBound = options.margin + options.halfW;
  const rightBound = options.W - options.margin - options.halfW;
  if (target < leftBound || target > rightBound) return null;
  return {
    startRatio: options.cx / options.W,
    startYRatio: options.cy / options.H,
    targetRatio: target / options.W,
    totalRatio: Math.abs(target - options.cx) / options.W,
  };
};
