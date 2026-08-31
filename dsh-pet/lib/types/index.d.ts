/**
 * ============================================================================
 * dsh-pet 宿主半侧的类型声明（TypeScript）
 * ============================================================================
 *
 * 【用途】
 *   给 lib/index.js（宿主半侧）提供类型信息，让 TypeScript 用户/编辑器
 *   在 import 本包时获得智能提示和类型检查。纯类型文件，不影响运行时。
 *
 * 【对应实现】
 *   lib/index.js —— 注册资源、配置、余额、会话计费、桌面伴生进程与诊断路由，并注册 /balance 命令。
 *
 * ============================================================================
 * @module dsh-pet
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';

/** Cordis 插件名（loader 诊断用），与 lib/index.js 的 name 一致 */
export declare const name = 'pet';
/** 需要注入 webServer / credentials / defaultModel / commands / sessions / homePaths 服务 */
export declare const inject: string[];

/**
 * 宿主插件主体：注册 /dsh-pet-7340 前缀路由、会话事件计费、桌面伴生进程和 /balance 命令。
 */
export declare function apply(ctx: Context): void;

export type { WebRoute };
