import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import license from 'rollup-plugin-license'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { resolve } from 'path'

type ScriptElement = {
  hasAttribute(name: string): boolean
  textContent: string | null
}

type HtmlDocument = {
  querySelectorAll(selector: string): Iterable<ScriptElement>
}

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom') as {
  JSDOM: new (html: string) => { window: { document: HtmlDocument } }
}

function hashDistFiles(dir: string, root = dir): string {
  const hash = createHash('sha256')
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    const path = resolve(dir, entry.name)
    const relativePath = path.slice(root.length + 1)

    if (entry.isDirectory()) {
      hash.update(`dir:${relativePath}\n`)
      hash.update(hashDistFiles(path, root))
      continue
    }

    if (!entry.isFile()) continue
    const { size } = statSync(path)
    hash.update(`file:${relativePath}:${size}\n`)
    hash.update(readFileSync(path))
  }

  return hash.digest('hex')
}

export default defineConfig({
  base: '/',
  define: {
    __DEPLOY_VERSION__: JSON.stringify(process.env.DEPLOY_VERSION ?? 'dev'),
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8788',
      '/auth': 'http://localhost:8788',
    },
  },
  plugins: [
    react(),
    license({
      thirdParty: {
        output: {
          file: resolve(__dirname, 'dist/LICENSES.txt'),
        },
      },
    }),
    {
      // Serve public/*.html at clean URLs to match Cloudflare Pages behavior.
      // e.g. /home → public/home.html, /privacy → public/privacy.html
      name: 'clean-url-html',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = req.url?.split('?')[0] ?? ''
          if (!pathname.startsWith('/') || pathname.includes('.')) return next()
          const candidate = resolve(__dirname, `public${pathname}.html`)
          if (existsSync(candidate)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(readFileSync(candidate, 'utf-8'))
            return
          }
          next()
        })
      },
    },
    {
      name: 'sw-cache-version-dev',
      apply: 'serve',
      buildStart() {
        const src = resolve(__dirname, 'public/sw.js')
        const distDir = resolve(__dirname, 'dist')
        if (!existsSync(distDir)) mkdirSync(distDir)
        const content = readFileSync(src, 'utf-8')
          .replace('__CACHE_VERSION__', `linger-dev-${Date.now()}`)
        writeFileSync(resolve(distDir, 'sw.js'), content)
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/sw.js') return next()
          const content = readFileSync(resolve(__dirname, 'public/sw.js'), 'utf-8')
            .replace('__CACHE_VERSION__', `linger-dev-${Date.now()}`)
          res.setHeader('Content-Type', 'application/javascript')
          res.end(content)
        })
      },
    },
    {
      name: 'csp-inline-hashes',
      apply: 'build',
      writeBundle() {
        const distPath = resolve(__dirname, 'dist')
        const html = readFileSync(resolve(distPath, 'index.html'), 'utf-8')
        const dom = new JSDOM(html)
        const scripts = Array.from(dom.window.document.querySelectorAll('script'))
          .filter((script) => !script.hasAttribute('src'))
          .map((script) => script.textContent ?? '')
          .filter((script) => script.length > 0)
        const hashes = scripts.map((script) => {
          const hash = createHash('sha256').update(script).digest('base64')
          return `'sha256-${hash}'`
        })
        const headersPath = resolve(distPath, '_headers')
        const updated = readFileSync(headersPath, 'utf-8')
          .replace('__INLINE_SCRIPT_HASHES__', hashes.join(' '))
        writeFileSync(headersPath, updated)
      },
    },
    {
      // Build-time prerender: render the signed-out <Landing> to static HTML and
      // inject it into dist/index.html's #root so `/` ships real, crawlable
      // content in its initial HTML. Runs before sw-cache-version so the injected
      // markup is included in the service-worker cache hash.
      name: 'prerender-landing',
      apply: 'build',
      async writeBundle() {
        const esbuild = require('esbuild') as typeof import('esbuild')
        const cacheDir = resolve(__dirname, 'node_modules/.cache/linger-prerender')
        mkdirSync(cacheDir, { recursive: true })
        const outfile = resolve(cacheDir, 'prerender.cjs')
        await esbuild.build({
          entryPoints: [resolve(__dirname, 'src/prerender.tsx')],
          outfile,
          bundle: true,
          // CJS so React's server renderer can require() Node builtins at runtime.
          format: 'cjs',
          platform: 'node',
          jsx: 'automatic',
          define: {
            'import.meta.env.BASE_URL': '"/"',
            'import.meta.env.DEV': 'false',
            'import.meta.env.PROD': 'true',
            'import.meta.env.MODE': '"production"',
            'process.env.NODE_ENV': '"production"',
          },
          logLevel: 'silent',
        })
        const { renderLanding } = require(outfile) as { renderLanding: () => string }
        const html = renderLanding()
        const indexPath = resolve(__dirname, 'dist/index.html')
        const index = readFileSync(indexPath, 'utf-8')
        const marker = '<div id="root"></div>'
        if (!index.includes(marker)) {
          throw new Error('prerender-landing: empty #root not found in dist/index.html')
        }
        writeFileSync(indexPath, index.replace(marker, `<div id="root">${html}</div>`))
        rmSync(cacheDir, { recursive: true, force: true })
      },
    },
    {
      name: 'sw-cache-version',
      writeBundle() {
        const distPath = resolve(__dirname, 'dist')
        const swPath = resolve(__dirname, 'dist/sw.js')
        const version = hashDistFiles(distPath).slice(0, 16)
        const content = readFileSync(swPath, 'utf-8').replace(
          '__CACHE_VERSION__',
          `linger-${version}`,
        )
        writeFileSync(swPath, content)
      },
    },
  ],
})
