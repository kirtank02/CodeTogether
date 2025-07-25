import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: false, // <-- THIS LINE IS CRITICAL
  transpilePackages: ['three'],
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(glsl|vs|fs|vert|frag)$/,
      exclude: /node_modules/,
      use: ['raw-loader'],
    })
    return config
  }
}

export default nextConfig