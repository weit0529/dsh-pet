/**
 * ============================================================================
 * dsh-pet 浏览器半侧的类型声明（TypeScript）
 * ============================================================================
 *
 * 【用途】
 *   给 lib/client.js（浏览器半侧）提供类型信息。纯类型文件，不影响运行时。
 *
 * 【对应实现】
 *   lib/client.js —— 注册宠物到官方 `shell.overlay` 列表槽，播放动画。
 *
 * ============================================================================
 * @module dsh-pet/client
 */
import type { Context } from '@deepseek-ai/dsh-client-runtime';

/** Cordis 插件名（loader 诊断用），与 lib/client.js 的 name 一致 */
export declare const name = 'pet';
/** 需要注入 slots / locale / connection / sessions 服务 */
export declare const inject: string[];

/**
 * 客户端插件主体：注册桌宠 overlay、设置页与系统通知。
 */
export declare function apply(ctx: Context): void;
