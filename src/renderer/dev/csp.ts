import type { Plugin } from 'vite';

// index.html 静态写死的是严格生产策略；dev server 还需要 inline 脚本
// （@vite/client、HMR、react-refresh 注入）和本地 ws/热更新连接。
// apply:'serve' 保证只有开发服务改写，build 产物保持严格策略。
export const relaxCspForDev = (html: string): string =>
  html
    .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    .replace(
      "connect-src 'self'",
      "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
    );

export function devCspPlugin(): Plugin {
  return {
    name: 'asi-dev-csp',
    apply: 'serve',
    transformIndexHtml: {
      order: 'pre',
      handler: relaxCspForDev,
    },
  };
}
