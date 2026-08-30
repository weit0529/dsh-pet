/** Host 侧用户配置的安全合并与基础校验。 */

export type JsonObject = Record<string, unknown>;

const CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
const ADVANCED_OBJECT_KEYS = new Set(['animations', 'animationWeights', 'eventsRefreshSec']);

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function sanitizePets(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const pets: unknown[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const id = String(item.id ?? '');
    // id 只作为稳定标识使用；禁止路径字符和控制字符，避免未来被误用为文件名。
    // eslint-disable-next-line no-control-regex
    if (!id || id.length > 64 || seen.has(id) || /[\\/:*?"<>|\x00-\x1f]/.test(id)) return null;
    const size = Number(item.size);
    if (!Number.isFinite(size) || size < 120 || size > 2000) return null;
    if (typeof item.balanceEnabled !== 'boolean') return null;
    if (!isRecord(item.position)) return null;
    const corner = String(item.position.corner ?? '');
    const marginX = Number(item.position.marginX);
    const marginY = Number(item.position.marginY);
    if (!CORNERS.has(corner) || !Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
    if (Math.abs(marginX) > 100_000 || Math.abs(marginY) > 100_000) return null;
    seen.add(id);
    pets.push({ id, size, balanceEnabled: item.balanceEnabled, position: { corner, marginX, marginY } });
  }
  return pets;
}

function sanitizePricingEntry(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  const out: JsonObject = {};
  for (const key of ['input', 'cacheRead', 'output'] as const) {
    if (value[key] === undefined) continue;
    const n = Number(value[key]);
    if (!Number.isFinite(n) || n < 0) return null;
    out[key] = n;
  }
  if (value.peakMultiplier !== undefined) {
    const n = Number(value.peakMultiplier);
    if (!Number.isFinite(n) || n <= 0) return null;
    out.peakMultiplier = n;
  }
  if (value.currency !== undefined) {
    const currency = String(value.currency).trim().toUpperCase();
    if (!/^[A-Z]{3,8}$/.test(currency)) return null;
    out.currency = currency;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 支持两种定价覆盖：
 * - 旧格式 pricing.{input,cacheRead,output,...}：仅覆盖 deepseek-v4-flash；
 * - 新格式 pricing.models.<modelId>：逐模型覆盖。
 */
function sanitizePricing(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  const flat = sanitizePricingEntry(value);
  const out: JsonObject = flat ?? {};
  if (value.models !== undefined) {
    if (!isRecord(value.models)) return null;
    const models: JsonObject = {};
    for (const [modelId, entry] of Object.entries(value.models)) {
      const id = modelId.trim().toLowerCase();
      if (!id || id.length > 128) return null;
      const clean = sanitizePricingEntry(entry);
      if (!clean) return null;
      models[id] = clean;
    }
    if (Object.keys(models).length === 0) return null;
    out.models = models;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 校验一个 PUT 配置片段；至少包含一个受支持字段 */
export function sanitizeUserConfigPatch(raw: unknown): JsonObject | null {
  if (!isRecord(raw)) return null;
  const out: JsonObject = {};

  if (raw.pets !== undefined) {
    const pets = sanitizePets(raw.pets);
    if (!pets) return null;
    out.pets = pets;
  }
  if (raw.notificationsEnabled !== undefined) {
    if (typeof raw.notificationsEnabled !== 'boolean') return null;
    out.notificationsEnabled = raw.notificationsEnabled;
  }
  if (raw.deepseekFullBalanceCny !== undefined) {
    const n = Number(raw.deepseekFullBalanceCny);
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000) return null;
    out.deepseekFullBalanceCny = n;
  }
  for (const key of ADVANCED_OBJECT_KEYS) {
    if (raw[key] === undefined) continue;
    if (!isRecord(raw[key])) return null;
    out[key] = copyJsonObject(raw[key] as JsonObject);
  }
  if (raw.pricing !== undefined) {
    const pricing = sanitizePricing(raw.pricing);
    if (!pricing) return null;
    out.pricing = pricing;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/** 设置页只更新自己提交的字段；已有高级配置和未来新增字段均原样保留 */
export function mergeUserConfig(existing: unknown, patch: JsonObject): JsonObject {
  const base = isRecord(existing) ? copyJsonObject(existing) : {};
  return { ...base, ...patch };
}

export function asJsonObject(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}
