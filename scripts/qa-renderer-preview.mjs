import { fileURLToPath } from 'node:url'
import { build, createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Browser-only visual QA. This intentionally never starts the native engine.
const root = fileURLToPath(new URL('..', import.meta.url))
const portArgument = process.argv.indexOf('--port')
const port = Number(portArgument === -1 ? 5173 : process.argv[portArgument + 1])
const config = {
  configFile: false,
  root,
  base: './',
  resolve: { alias: { '@': `${root}/src/renderer/src` } },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port, strictPort: true }
}
if (process.argv.includes('--build')) {
  await build({ ...config, build: { outDir: 'out/renderer-preview', emptyOutDir: true, rollupOptions: { input: { app: `${root}/scripts/fixtures/renderer-preview/app.html`, controls: `${root}/scripts/fixtures/renderer-preview/index.html` } } } })
  process.exit(0)
}
const server = await createServer(config)
await server.listen()
console.log(`Renderer QA controls: http://localhost:${port}/scripts/fixtures/renderer-preview/index.html`)
console.log(`Direct app: http://localhost:${port}/scripts/fixtures/renderer-preview/app.html?view=composer&theme=dawn&subtitles=none&probe=success`)
console.log('Mock engine only; traffic lights are a visible geometry fixture, not native macOS controls.')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
