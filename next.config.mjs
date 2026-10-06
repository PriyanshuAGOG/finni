/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  serverExternalPackages: ['pdf-parse', 'pg'],
  // The gpt-actions.yaml route reads openapi/gpt-actions.yaml from disk at
  // request time rather than importing it, so Vercel's build-time file
  // tracing wouldn't otherwise know to bundle it into that function. The
  // MCP server reads docs/gpt-instructions.md the same way, to serve it
  // as the initialize response's `instructions` field.
  outputFileTracingIncludes: {
    '/gpt-actions.yaml': ['./openapi/gpt-actions.yaml'],
    '/mcp': ['./docs/gpt-instructions.md'],
  },
};

export default nextConfig;
