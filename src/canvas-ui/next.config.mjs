/**
 * Static export so the same artifact runs (a) as a plain web app and
 * (b) inside the macOS WKWebView shell via a custom WKURLSchemeHandler.
 * All server work (DB, agent, real-time) lives in the Python Comms Service,
 * so we deliberately do NOT need a Next.js Node server in the bundle.
 * See ../../knowledge-base/architecture-patterns/webview-shell-and-data-path.md
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true }, // no server image optimizer in a static export
  reactStrictMode: true,
}

export default nextConfig
