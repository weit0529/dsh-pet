/**
 * dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
 *
 * 职责：在 DSH Web 服务器上注册 `/dsh-pet-7340/` 前缀路由，把宠物动画 WebM / 配置 JSONC
 * 流式返回给浏览器。源文件（src/host/index.ts）由 tsdown 构建为 lib/index.js。
 *
 * 路由：
 *   /dsh-pet-7340/thumb/<动画名>.<ext>  → 按扩展名分流：.webm→$DSH_HOME/dsh-pet/main-animation/webm（用户目录，优先）→ 包内 assets/webm；
 *                                       .mov → $DSH_HOME/dsh-pet/main-animation/mov（用户目录，优先）→ 包内 assets/mov
 *   /dsh-pet-7340/config.jsonc        → 插件包内 assets/config.jsonc（默认值，只读）
 *   /dsh-pet-7340/config              → 用户覆盖配置（局部更新并保留未提交字段，JSON）
 *                                GET 读取、PUT 保存、DELETE 恢复默认（删除用户层）
 *   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径（设置页展示用）
 *   /dsh-pet-7340/balance?sessionId=  → 指定 DSH 会话当前服务商的余额
 *   /dsh-pet-7340/balance/trigger     → 按会话隔离的手动触发计数（/balance 命令）
 *   /dsh-pet-7340/turn-spend          → 指定会话最近一轮 DeepSeek token 费用
 *
 * 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内。
 *
 * TODO(类型)：peer 依赖类型包本地暂不可解析，ctx/req/res 暂用 any；
 *             依赖可解析后替换为 DSH 官方类型。
 */
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { matchBalanceProvider, queryBalance, type BalanceResult } from './balance';
import { calculateTokenCost, createPricingManager, type Pricing, type PricingSource } from './pricing-catalog';
import { asJsonObject, mergeUserConfig, sanitizeUserConfigPatch, type JsonObject } from './user-config';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：路由、默认模型、凭证、命令和会话存储 */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'commands', 'sessions'];

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 路由前缀 */
const ROUTE_PREFIX = '/dsh-pet-7340';

/** 不同扩展名对应的 Content-Type 映射 */
const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
 */
function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  if (!candidate || !existsSync(candidate) || !existsSync(root)) return undefined;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    return realCandidate.startsWith(rootWithSep) ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

/** 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。 */
async function sendFile(
  res: ServerResponse,
  file: string,
  contentType: string,
  cacheControl = 'public, max-age=3600',
): Promise<void> {
  const { size } = await stat(file);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': size,
    'cache-control': cacheControl,
  });
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * DeepSeek 峰谷计价档位（北京时间）——与 client/balance.ts 的 deepseekPricingTier 同逻辑，
 * 用于 token 成本估算的峰谷倍率。官方规则：工作日 9:00–12:00、14:00–18:00 为高峰；
 * 其余为空闲（低谷）；周六/周日全天按低谷价计费（自 2026-08-23 起周末不分峰谷）。
 */
function isDeepseekPeakNow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const MAX_CONFIG_BODY_BYTES = 1_000_000;
const MAX_SESSION_ID_LENGTH = 256;

function validSessionId(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH;
}

/** 收集有上限的请求体，防止配置接口被超大 body 占满内存 */
function readBody(req: IncomingMessage, maxBytes = MAX_CONFIG_BODY_BYTES): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer | string) => {
      if (tooLarge) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('request-body-too-large'));
      else resolve2(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const userRoot = join(resolveDshHome(), 'dsh-pet');
  // 用户覆盖配置（设置页局部保存；高级配置与未来字段会保留）
  const userConfigPath = join(userRoot, 'main-config.json');
  // 用户动画目录（thumb 播放时优先于包内素材；按扩展名在 webm/mov 子目录分流）
  const thumbUserRoot = join(userRoot, 'main-animation');
  // 手动触发计数按会话隔离：/balance 只唤醒发出命令的那一个会话页面。
  const balanceTriggerCounts = new Map<string, number>();

  // 余额请求单飞：同一 provider 同时只允许一个上游请求，短暂复用结果吸收点击/轮询抖动。
  const balanceInFlight = new Map<string, Promise<BalanceResult>>();
  const balanceRecent = new Map<string, { at: number; value: BalanceResult }>();
  const BALANCE_CACHE_MS = 1_000;
  const fetchProviderBalance = (provider: string): Promise<BalanceResult> => {
    const recent = balanceRecent.get(provider);
    if (recent && Date.now() - recent.at <= BALANCE_CACHE_MS) return Promise.resolve(recent.value);
    const current = balanceInFlight.get(provider);
    if (current) return current;
    const request = queryBalance(provider, async (ref) => {
      const resolved = await ctx.credentials.resolve(credentialRef(ref));
      return resolved?.value;
    })
      .then((value) => {
        balanceRecent.set(provider, { at: Date.now(), value });
        return value;
      })
      .finally(() => balanceInFlight.delete(provider));
    balanceInFlight.set(provider, request);
    return request;
  };

  type ModelSelection = { provider: string; model: string };
  const defaultSelection = (): ModelSelection => {
    const selection = ctx.agentDefaultModel.currentSelection();
    return { provider: String(selection.provider), model: String(selection.model) };
  };
  const selectionForSession = (sessionId: string | null): ModelSelection => {
    if (sessionId) {
      const session = ctx.sessions.get(sessionId);
      const header = session?.requestHeader?.();
      const provider = header?.config?.provider;
      const model = header?.config?.model;
      if (typeof provider === 'string' && provider && typeof model === 'string' && model) return { provider, model };
    }
    return defaultSelection();
  };
  const isDeepseekProvider = (provider: string): boolean => matchBalanceProvider(provider)?.kind === 'deepseek';

  // ---- 用户定价覆盖：旧 flat 格式只覆盖 flash；新 models 格式逐模型覆盖 ----
  const pricingManager = createPricingManager();
  const pricingOverrides = new Map<string, Partial<Pricing>>();
  const loadPricingOverrides = async (): Promise<void> => {
    pricingOverrides.clear();
    try {
      const parsed = asJsonObject(JSON.parse(await readFile(userConfigPath, 'utf8')));
      const pricing = asJsonObject(parsed?.pricing);
      if (!pricing) return;
      const readEntry = (entry: JsonObject): Partial<Pricing> => {
        const out: Partial<Pricing> = {};
        for (const key of ['input', 'cacheRead', 'output', 'peakMultiplier'] as const) {
          if (typeof entry[key] === 'number' && Number.isFinite(entry[key])) out[key] = entry[key];
        }
        if (typeof entry.currency === 'string' && entry.currency) out.currency = entry.currency;
        return out;
      };
      const legacy = readEntry(pricing);
      if (Object.keys(legacy).length > 0) pricingOverrides.set('deepseek-v4-flash', legacy);
      const models = asJsonObject(pricing.models);
      if (models) {
        for (const [modelId, value] of Object.entries(models)) {
          const entry = asJsonObject(value);
          if (entry) pricingOverrides.set(modelId.trim().toLowerCase(), readEntry(entry));
        }
      }
    } catch {
      /* 配置不存在或暂时不可读：使用官方/内置目录 */
    }
  };
  const pricingFor = (modelId: string): { pricing?: Pricing; source: PricingSource | 'user-override' } => {
    const key = modelId.trim().toLowerCase();
    const base = pricingManager.current(key);
    const override = pricingOverrides.get(key);
    if (!override) return { pricing: base, source: pricingManager.source(key) };
    const input = override.input ?? base?.input;
    const cacheRead = override.cacheRead ?? base?.cacheRead;
    const output = override.output ?? base?.output;
    if (input === undefined || cacheRead === undefined || output === undefined) {
      return { source: 'unavailable' };
    }
    return {
      pricing: {
        input,
        cacheRead,
        output,
        peakMultiplier: override.peakMultiplier ?? base?.peakMultiplier ?? 2,
        currency: override.currency ?? base?.currency ?? 'CNY',
      },
      source: 'user-override',
    };
  };
  void loadPricingOverrides();
  pricingManager.start();

  // ---- 每轮对话消费：按 session + turn + 实际 provider/model/时段累加 ----
  type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
  type UsageBucket = Usage & { model: string; peak: boolean };
  type TurnState = {
    turn: number;
    route?: ModelSelection;
    buckets: Map<string, UsageBucket>;
    hasNonDeepseekUsage: boolean;
  };
  type TurnSpend = {
    count: number;
    amount: number;
    currency: string;
    at: number;
    models: string[];
  };
  const turns = new Map<string, TurnState>();
  const spendBySession = new Map<string, TurnSpend>();
  const eventDiag: { at: number; type: string; turn?: number; reasonKind?: string }[] = [];
  const diagAppend = (type: string, data?: { turn?: number; reason?: { kind?: string } }) => {
    eventDiag.push({ at: Date.now(), type, turn: data?.turn, reasonKind: data?.reason?.kind });
    if (eventDiag.length > 60) eventDiag.shift();
  };
  const safeToken = (value: unknown): number => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  ctx.on(
    'session/event',
    (
      session: { id: unknown; requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined },
      event: {
        type: string;
        time?: number;
        data?: {
          turn?: number;
          reason?: { kind?: string };
          header?: { config?: { provider?: string; model?: string } };
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
        };
      },
    ) => {
      const sessionId = String(session.id ?? '');
      if (!sessionId) return;
      diagAppend(event.type, event.data);

      if (event.type === 'turn/start') {
        turns.set(sessionId, {
          turn: Number(event.data?.turn ?? -1),
          buckets: new Map(),
          hasNonDeepseekUsage: false,
        });
        return;
      }

      const state = turns.get(sessionId);
      if (event.type === 'request/header') {
        if (!state) return;
        const provider = event.data?.header?.config?.provider;
        const model = event.data?.header?.config?.model;
        if (typeof provider === 'string' && provider && typeof model === 'string' && model) {
          state.route = { provider, model };
        }
        return;
      }

      if (event.type === 'assistant/message') {
        if (!state) return;
        const usage = event.data?.usage;
        if (!usage) return;
        const input = safeToken(usage.inputTokens);
        const output = safeToken(usage.outputTokens);
        const cacheRead = safeToken(usage.cacheReadTokens);
        const cacheWrite = safeToken(usage.cacheWriteTokens);
        if (input + output + cacheRead + cacheWrite === 0) return;

        const header = session.requestHeader?.();
        const fallbackRoute =
          typeof header?.config?.provider === 'string' && typeof header?.config?.model === 'string'
            ? { provider: header.config.provider, model: header.config.model }
            : undefined;
        const route = state.route ?? fallbackRoute;
        if (!route || !isDeepseekProvider(route.provider)) {
          state.hasNonDeepseekUsage = true;
          return;
        }

        const peak = isDeepseekPeakNow(new Date(event.time ?? Date.now()));
        const key = route.model.trim().toLowerCase() + '|' + (peak ? 'peak' : 'idle');
        const bucket = state.buckets.get(key) ?? {
          model: route.model.trim().toLowerCase(),
          peak,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
        bucket.input += input;
        bucket.output += output;
        bucket.cacheRead += cacheRead;
        bucket.cacheWrite += cacheWrite;
        state.buckets.set(key, bucket);
        return;
      }

      if (event.type !== 'turn/end') return;
      turns.delete(sessionId);
      if (event.data?.reason?.kind !== 'completed' || !state || state.hasNonDeepseekUsage || state.buckets.size === 0) {
        return;
      }

      let amount = 0;
      const currencies = new Set<string>();
      const models = new Set<string>();
      for (const bucket of state.buckets.values()) {
        const resolved = pricingFor(bucket.model);
        if (!resolved.pricing) {
          console.warn('[dsh-pet] turn-spend 跳过：没有模型 ' + bucket.model + ' 的定价');
          return;
        }
        models.add(bucket.model);
        currencies.add(resolved.pricing.currency);
        amount += calculateTokenCost(bucket, resolved.pricing, bucket.peak);
      }
      if (currencies.size !== 1) {
        console.warn('[dsh-pet] turn-spend 跳过：同一轮出现多个计费币种');
        return;
      }
      if (!Number.isFinite(amount) || amount <= 0) return;
      const currency = currencies.values().next().value as string;

      const previous = spendBySession.get(sessionId);
      const settled: TurnSpend = {
        count: (previous?.count ?? 0) + 1,
        amount,
        currency,
        at: Date.now(),
        models: [...models],
      };
      spendBySession.delete(sessionId);
      spendBySession.set(sessionId, settled);
      while (spendBySession.size > 200) {
        const oldest = spendBySession.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        spendBySession.delete(oldest);
      }
      console.log(
        '[dsh-pet] turn-spend amount=' + amount.toFixed(6) + ' ' + currency + ' model=' + settled.models.join(','),
      );
    },
  );

  /** 包内动画素材根：按扩展名分格式存放（assets/webm 或 assets/mov）。 */
  const assetRootFor = (ext: string): string =>
    ext === '.mov' ? join(PACKAGE_ROOT, 'assets', 'mov') : join(PACKAGE_ROOT, 'assets', 'webm');

  /** 用户动画根：同扩展名分流（main-animation/webm 或 main-animation/mov）。 */
  const userRootFor = (ext: string): string =>
    ext === '.mov' ? join(thumbUserRoot, 'mov') : join(thumbUserRoot, 'webm');

  const readUserConfig = async (): Promise<JsonObject> => {
    if (!existsSync(userConfigPath)) return {};
    const parsed = asJsonObject(JSON.parse(await readFile(userConfigPath, 'utf8')));
    if (!parsed) throw new Error('existing user config is not a JSON object');
    return parsed;
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          let rest: string;
          try {
            rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
          } catch {
            sendJson(res, 400, { error: 'malformed URL encoding' });
            return;
          }

          // 用户覆盖配置：/dsh-pet-7340/config（GET / PUT / DELETE）
          if (rest === 'config') {
            if (req.method === 'GET') {
              if (!existsSync(userConfigPath)) {
                sendJson(res, 200, {});
                return;
              }
              try {
                const raw = await readFile(userConfigPath, 'utf8');
                sendJson(res, 200, JSON.parse(raw));
              } catch (error) {
                sendJson(res, 500, {
                  error: 'user config is unreadable',
                  message: error instanceof Error ? error.message : String(error),
                });
              }
              return;
            }
            if (req.method === 'PUT') {
              let body: string;
              try {
                body = await readBody(req);
              } catch (error) {
                const tooLarge = error instanceof Error && error.message === 'request-body-too-large';
                sendJson(res, tooLarge ? 413 : 400, {
                  error: tooLarge ? 'config body too large' : 'invalid request body',
                });
                return;
              }
              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                sendJson(res, 400, { error: 'invalid JSON body' });
                return;
              }
              const cleanPatch = sanitizeUserConfigPatch(parsed);
              if (!cleanPatch) {
                sendJson(res, 400, { error: 'invalid config patch' });
                return;
              }
              try {
                const merged = mergeUserConfig(await readUserConfig(), cleanPatch);
                await mkdir(userRoot, { recursive: true });
                await writeFile(userConfigPath, JSON.stringify(merged, null, 2), 'utf8');
                await loadPricingOverrides();
                sendJson(res, 200, { ok: true });
              } catch (error) {
                sendJson(res, 500, {
                  error: 'failed to save user config',
                  message: error instanceof Error ? error.message : String(error),
                });
              }
              return;
            }
            if (req.method === 'DELETE') {
              try {
                await rm(userConfigPath, { force: true });
              } catch (error) {
                sendJson(res, 500, {
                  error: 'failed to delete user config',
                  message: error instanceof Error ? error.message : String(error),
                });
                return;
              }
              await loadPricingOverrides();
              sendJson(res, 200, { ok: true });
              return;
            }
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }

          // 配置文件路径（设置页「高级配置」展示用）
          if (rest === 'config/meta') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            sendJson(res, 200, {
              user: userConfigPath,
              default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
              animations: thumbUserRoot,
            });
            return;
          }

          // 余额查询（client 定时/手动拉取；结果由 host 侧完成全部抓取与校验，client 不接触 key）
          if (rest === 'balance') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            try {
              const sessionId = url.searchParams.get('sessionId');
              if (sessionId !== null && !validSessionId(sessionId)) {
                sendJson(res, 400, { error: 'invalid sessionId' });
                return;
              }
              const selection = selectionForSession(sessionId);
              const result = await fetchProviderBalance(selection.provider);
              // 余额必须实时：显式 no-store，禁止浏览器/代理缓存。
              const body = JSON.stringify(result);
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-cache, no-store',
                'content-length': Buffer.byteLength(body),
              });
              res.end(body);
            } catch (e) {
              // 意外异常（如注入服务缺失）：显式 500，不静默
              sendJson(res, 500, {
                ok: false,
                provider: 'unknown',
                reason: 'fetch-error',
                message: e instanceof Error ? e.message : String(e),
              });
            }
            return;
          }

          // 手动触发计数：/dsh-pet-7340/balance/trigger（no-cache，client 轻量轮询；/balance 命令写入）
          if (rest === 'balance/trigger') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            const sessionId = url.searchParams.get('sessionId');
            if (!validSessionId(sessionId)) {
              sendJson(res, 400, { error: sessionId === null ? 'sessionId is required' : 'invalid sessionId' });
              return;
            }
            const body = JSON.stringify({ count: balanceTriggerCounts.get(sessionId) ?? 0 });
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache, no-store', // 触发计数必须实时，禁止任何缓存层介入
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
          }

          // 每轮对话消耗：必须带当前 sessionId，杜绝不同会话/页面互相串值。
          if (rest === 'turn-spend') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            const sessionId = url.searchParams.get('sessionId');
            if (!validSessionId(sessionId)) {
              sendJson(res, 400, { error: sessionId === null ? 'sessionId is required' : 'invalid sessionId' });
              return;
            }
            const spend = spendBySession.get(sessionId);
            const body = JSON.stringify(
              spend ? { ok: true, ...spend } : { ok: true, count: 0, amount: 0, currency: '', at: 0, models: [] },
            );
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache, no-store',
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
          }

          // 诊断端点：仅返回聚合状态和去标识事件，不暴露 sessionId。
          if (rest === 'turn-spend/debug') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            const catalog = pricingManager.snapshot();
            const models = new Set([...Object.keys(catalog), ...pricingOverrides.keys()]);
            sendJson(res, 200, {
              activeTurnCount: turns.size,
              settledSessionCount: spendBySession.size,
              pricing: Object.fromEntries(
                [...models].map((model) => {
                  const resolved = pricingFor(model);
                  return [model, { pricing: resolved.pricing, source: resolved.source }];
                }),
              ),
              events: eventDiag,
            });
            return;
          }

          // 下面均为只读静态资源路由。
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }

          // 配置文件（JSONC）：/dsh-pet-7340/config.jsonc → 包内 assets/config.jsonc
          if (rest === 'config.jsonc') {
            const cfgFile = join(PACKAGE_ROOT, 'assets', 'config.jsonc');
            if (!existsSync(cfgFile)) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: config.jsonc not found');
              return;
            }
            await sendFile(res, cfgFile, MIME['.jsonc'] ?? 'application/octet-stream', 'no-cache');
            return;
          }

          // 字体文件：/dsh-pet-7340/font/<file> → 包内 assets/fonts
          const [scope, ...nameParts] = rest.split('/');
          if (scope === 'font') {
            const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
            const fontFile = resolveExisting(fontRoot, nameParts.join('/'));
            if (fontFile === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: font not found');
              return;
            }
            const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
            await sendFile(res, fontFile, MIME[ext] ?? 'application/octet-stream');
            return;
          }

          // 通知图标：/dsh-pet-7340/pic/<file> → 包内 assets/pic（方形 png，通知 icon 用）
          if (scope === 'pic') {
            const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
            const picFile = resolveExisting(picRoot, nameParts.join('/'));
            if (picFile === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: pic not found');
              return;
            }
            const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
            await sendFile(res, picFile, MIME[ext] ?? 'application/octet-stream');
            return;
          }

          // 动画文件：/dsh-pet-7340/thumb/<file>，按扩展名分格式目录
          // （.webm → assets/webm，.mov → assets/mov），查找顺序 = 用户动画目录 → 包内素材
          if (scope !== 'thumb') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: expected /dsh-pet-7340/thumb/<file>');
            return;
          }
          const fileName = nameParts.join('/');
          const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
          if (ext !== '.webm' && ext !== '.mov') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: unsupported animation format (expected .webm or .mov)');
            return;
          }
          const file = resolveExisting(userRootFor(ext), fileName) ?? resolveExisting(assetRootFor(ext), fileName);
          if (file === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: asset not found');
            return;
          }
          await sendFile(res, file, MIME[ext] ?? 'application/octet-stream');
        },
      }),
    'dsh-pet: /dsh-pet-7340 asset route',
  );

  // /balance 斜杠命令：只递增接收该命令的会话计数。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'balance',
        description: '手动触发桌宠余额动画（立即显示余额气泡）',
        handler: (invocation: { agent: { id: unknown } }) => {
          const sessionId = String(invocation.agent.id);
          if (!validSessionId(sessionId)) return { kind: 'error', text: '无法识别当前会话，未触发余额动画' };
          const nextCount = (balanceTriggerCounts.get(sessionId) ?? 0) + 1;
          balanceTriggerCounts.delete(sessionId);
          balanceTriggerCounts.set(sessionId, nextCount);
          while (balanceTriggerCounts.size > 200) {
            const oldest = balanceTriggerCounts.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            balanceTriggerCounts.delete(oldest);
          }
          return { kind: 'success', text: '已触发桌宠余额动画' };
        },
      }),
    'dsh-pet: /balance command',
  );

  // 插件卸载时停止官网定价周期刷新（清理定时器）
  ctx.effect(
    () => () => {
      pricingManager.dispose();
    },
    'dsh-pet: pricing manager dispose',
  );
}
