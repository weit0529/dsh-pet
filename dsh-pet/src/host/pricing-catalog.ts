/**
 * DeepSeek 官方定价目录（host 半侧）。
 *
 * 一次抓取官方中文定价页并解析全部模型，避免按模型重复请求同一页面。
 * 抓取失败时只对内置已知模型使用明确的默认价；未知模型返回 undefined，
 * 调用方据此跳过结算，绝不静默套用另一模型的价格。
 */

const PRICING_DOC_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const PRICING_REFRESH_MS = 6 * 60 * 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 15_000;

/** 一个模型的一档价格（人民币元/百万 tokens） */
export interface Pricing {
  /** 输入（缓存未命中；缓存写入也按此档） */
  input: number;
  /** 输入（缓存命中） */
  cacheRead: number;
  /** 输出 */
  output: number;
  /** 高峰相对空闲的倍率 */
  peakMultiplier: number;
  currency: string;
}

export type PricingCatalog = Record<string, Pricing>;

/** 官方页面抓取失败时的已知价格快照（2026-08） */
export const DEFAULT_PRICING_BY_MODEL: PricingCatalog = {
  'deepseek-v4-flash': { input: 1.5, cacheRead: 0.05, output: 4.5, peakMultiplier: 2, currency: 'CNY' },
  'deepseek-v4-pro': { input: 4.5, cacheRead: 0.15, output: 13.5, peakMultiplier: 2, currency: 'CNY' },
  'deepseek-v4-flash-vision-exp': {
    input: 1.5,
    cacheRead: 0.05,
    output: 4.5,
    peakMultiplier: 2,
    currency: 'CNY',
  },
};

export const DEFAULT_PRICING: Pricing = DEFAULT_PRICING_BY_MODEL['deepseek-v4-flash'];

const normalizeModelId = (modelId: string): string => modelId.trim().toLowerCase();

function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&yen;|&#165;/gi, '¥')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function cellText(row: string): string[] {
  return [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => plainText(m[1])).filter(Boolean);
}

function toNum(value: string): number {
  const normalized = value.replace(/[¥$,\s元]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** 找到真正包含 DeepSeek 模型价格的表格 */
function pricingRows(html: string): string[][] {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  for (const table of tables) {
    const rows = [...table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)]
      .map((m) => cellText(m[0]))
      .filter((row) => row.length > 0);
    const header = rows.find((row) => row[0]?.includes('模型'));
    if (header && header.slice(1).some((cell) => normalizeModelId(cell).startsWith('deepseek-'))) return rows;
  }
  return [];
}

/** 从官方 HTML 一次解析全部模型价格 */
export function parsePricingCatalogHtml(html: string): PricingCatalog {
  const rows = pricingRows(html);
  const header = rows.find((row) => row[0]?.includes('模型'));
  if (!header) return {};

  const models = header.slice(1).map(normalizeModelId);
  const prices = models.map(() => ({
    cacheHit: {} as Partial<Record<'offPeak' | 'peak', number>>,
    cacheMiss: {} as Partial<Record<'offPeak' | 'peak', number>>,
    output: {} as Partial<Record<'offPeak' | 'peak', number>>,
  }));
  let metric: 'cacheHit' | 'cacheMiss' | 'output' | null = null;

  for (const row of rows) {
    const joined = row.join(' ');
    if (joined.includes('缓存未命中')) metric = 'cacheMiss';
    else if (joined.includes('缓存命中')) metric = 'cacheHit';
    else if (joined.includes('百万tokens输出') || joined.includes('百万 tokens 输出')) metric = 'output';

    const tagIndex = row.findIndex((cell) => cell.includes('空闲时段') || cell.includes('高峰时段'));
    if (!metric || tagIndex < 0) continue;
    const tier = row[tagIndex].includes('高峰') ? 'peak' : 'offPeak';
    const values = row.slice(tagIndex + 1).map(toNum);
    for (let i = 0; i < models.length; i += 1) {
      const value = values[i];
      if (Number.isFinite(value)) prices[i][metric][tier] = value;
    }
  }

  const catalog: PricingCatalog = {};
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const p = prices[i];
    const input = p.cacheMiss.offPeak;
    const cacheRead = p.cacheHit.offPeak;
    const output = p.output.offPeak;
    if (![input, cacheRead, output].every(Number.isFinite)) continue;
    const outputPeak = p.output.peak;
    const peakMultiplier = Number.isFinite(outputPeak) && output && output > 0 ? Number(outputPeak) / output : 2;
    catalog[model] = {
      input: Number(input),
      cacheRead: Number(cacheRead),
      output: Number(output),
      peakMultiplier: Number.isFinite(peakMultiplier) && peakMultiplier > 0 ? peakMultiplier : 2,
      currency: 'CNY',
    };
  }
  return catalog;
}

/** 找不到指定模型时返回 null，不再错误回落到表格第一列 */
export function parsePricingHtml(html: string, modelId = 'deepseek-v4-flash'): Pricing | null {
  return parsePricingCatalogHtml(html)[normalizeModelId(modelId)] ?? null;
}

export async function fetchOfficialPricingCatalog(): Promise<PricingCatalog> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICING_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(PRICING_DOC_URL, { signal: controller.signal });
    if (!response.ok) return {};
    return parsePricingCatalogHtml(await response.text());
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

export type PricingSource = 'official' | 'default' | 'unavailable';

export interface PricingManager {
  current(modelId: string): Pricing | undefined;
  source(modelId: string): PricingSource;
  snapshot(): PricingCatalog;
  start(): void;
  dispose(): void;
  refresh(): Promise<void>;
}

/** 单实例、单定时器的全模型价格管理器 */
export function createPricingManager(): PricingManager {
  let official: PricingCatalog = {};
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const next = await fetchOfficialPricingCatalog();
      if (Object.keys(next).length > 0) {
        official = next;
        console.log('[dsh-pet] 官方定价目录已更新：' + Object.keys(next).join(', '));
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    current(modelId: string): Pricing | undefined {
      const key = normalizeModelId(modelId);
      return official[key] ?? DEFAULT_PRICING_BY_MODEL[key];
    },
    source(modelId: string): PricingSource {
      const key = normalizeModelId(modelId);
      if (official[key]) return 'official';
      if (DEFAULT_PRICING_BY_MODEL[key]) return 'default';
      return 'unavailable';
    },
    snapshot(): PricingCatalog {
      return { ...DEFAULT_PRICING_BY_MODEL, ...official };
    },
    start(): void {
      void refresh();
      if (timer === null) timer = setInterval(() => void refresh(), PRICING_REFRESH_MS);
    },
    dispose(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    refresh,
  };
}

/** cacheWrite 按缓存未命中输入计价 */
export function calculateTokenCost(
  usage: { input: number; output: number; cacheRead: number; cacheWrite?: number },
  pricing: Pricing,
  isPeak: boolean,
): number {
  const multiplier = isPeak ? pricing.peakMultiplier : 1;
  return (
    (((usage.input + (usage.cacheWrite ?? 0)) * pricing.input +
      usage.cacheRead * pricing.cacheRead +
      usage.output * pricing.output) /
      1_000_000) *
    multiplier
  );
}
