// tsdown 配置（仿官方 DSH 客户端插件的构建方式：src → lib 产物）
// 说明：DSH 浏览器插件生产出的 lib/client.js 必须是
//       window.__ModuleLoader__.load({ id, factory }) 单文件形态；
//       react / react/jsx-runtime / @deepseek-ai/* 保持外部 require（不打包）。
import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: { client: 'src/client/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    external: [/^@deepseek-ai\//, /^node:/],
    dts: false,
    outDir: 'lib',
    clean: false,
  },
  {
    entry: { index: 'src/host/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    external: [/^@deepseek-ai\//, /^node:/],
    dts: false,
    outDir: 'lib',
    clean: false,
  },
  {
    entry: { main: 'src/desktop/main.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    external: ['electron', /^node:/],
    dts: false,
    outDir: 'desktop/lib',
    clean: false,
  },
  {
    entry: { renderer: 'src/desktop/renderer.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    outDir: 'desktop/lib',
    clean: false,
  },
  {
    entry: { preload: 'src/desktop/preload.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'es2022',
    external: ['electron'],
    dts: false,
    outDir: 'desktop/lib',
    clean: false,
  },
]);
