/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Kamino klend-sdk → kliquidity-sdk → @orca-so/whirlpools-core (WASM). Bundling WASM into
  // .next/server/chunks breaks at prerender (ENOENT on *._bg.wasm). Keep these as Node externals.
  serverExternalPackages: [
    '@orca-so/whirlpools-core',
    '@orca-so/whirlpools',
    '@orca-so/whirlpools-client',
    '@kamino-finance/kliquidity-sdk',
  ],
  // Optimize chunk loading for Vercel deployment
  webpack: (config, { isServer }) => {
    if (!isServer) {
	  // @kamino-finance/klend-sdk (and similar) may reference Node built-ins behind optional paths;
      // the browser bundle must not try to resolve them.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
      // @walletconnect/logger → pino optional dev dependency (not installed in prod)
      config.resolve.alias = {
        ...config.resolve.alias,
        'pino-pretty': false,
      };
      // Chunk splitting without fixed names to avoid CSS being loaded as JS
      // (named chunks like "vendor-js" get both .js and .css; runtime can request wrong one)
      config.optimization.splitChunks = {
        chunks: 'all',
        cacheGroups: {
          default: {
            minChunks: 2,
            priority: -20,
            reuseExistingChunk: true,
          },
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            priority: -10,
            chunks: 'all',
          },
          protocols: {
            test: /[\\/]lib[\\/]protocols[\\/]/,
            priority: 10,
            chunks: 'all',
          },
          services: {
            test: /[\\/]lib[\\/]services[\\/]/,
            priority: 5,
            chunks: 'all',
          },
        },
      };
      // Handle WASM files from @lightprotocol/hasher.rs
      config.module.rules.push({
        test: /\.wasm$/,
        type: 'asset/resource',
        generator: {
          filename: 'static/wasm/[name][ext]',
        },
      });
      // Ensure WASM files are not processed as modules
      config.resolve.extensionAlias = {
        '.js': ['.js', '.ts', '.tsx'],
        '.wasm': ['.wasm'],
      };
    }
    return config;
  },
  // Add experimental features for better chunk handling
  experimental: {
    optimizePackageImports: ['@radix-ui/react-icons', 'lucide-react'],
    // Disable Turbopack for WASM compatibility (can re-enable after testing)
    // turbopack: undefined,
  },
  // Optimize images for better loading
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'assets.panora.exchange',
        port: '',
        pathname: '/tokens/**',
      },
      {
        protocol: 'https',
        hostname: 'ariesmarkets.xyz',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'app.earnium.io',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'app.decibel.trade',
        port: '',
        pathname: '/images/**',
      },
    ],
    domains: [
      'hyperion.xyz',
      'ariesmarkets.xyz',
      'app.joule.finance',
      'app.echelon.market',
      'cdn.jsdelivr.net',
      'tether.to',
      'tapp.exchange',
      'app.meso.finance',
      'app.auro.finance',
      'app.kofi.finance',
      'app.earnium.io'
    ],
    // Add image optimization settings
    formats: ['image/webp', 'image/avif'],
    minimumCacheTTL: 60,
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    // Add loader for better image handling
    loader: 'default',
    // Optimize for custom domains
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },
  // Add output configuration for better deployment
  output: 'standalone',
  // Add trailing slash for better routing
  trailingSlash: false,
  // Add compression
  compress: true,
  // Add powered by header removal
  poweredByHeader: false,
}

module.exports = nextConfig 