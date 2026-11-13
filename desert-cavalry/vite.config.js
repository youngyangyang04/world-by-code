import { defineConfig } from 'vite';

// 本项目是纯静态页面：不联网、不读写 Cookie / localStorage、不加载任何第三方脚本。
// 下面这组响应头把这一点固化下来，`npm run preview` 会带着它们启动；
// 正式部署时请在 Nginx / CDN 上配置同样的头（见 README「部署」）。
export const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", // 模型内嵌贴图以 blob: 方式解码
    "media-src 'self' blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

// 开发服务器与预览服务器都只监听本机回环地址（127.0.0.1），
// 局域网和公网上的其他机器访问不到。不要改成 0.0.0.0 / --host 暴露出去：
// Vite 的 dev server 不是为公网设计的，正式部署请用 `npm run build` 产出的 dist/ 静态文件。
export default defineConfig({
  base: './',
  server: { port: 5173, host: '127.0.0.1', strictPort: true },
  preview: { port: 4173, host: '127.0.0.1', strictPort: true, headers: SECURITY_HEADERS },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
