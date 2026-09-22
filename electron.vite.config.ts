import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { relayStoreURL } from './src/shared/relayDistribution'

const relayURL = relayStoreURL(process.env.NDM_RELAY_STORE_URL)

export default defineConfig({
  main: {
    define: { __NDM_RELAY_STORE_URL__: JSON.stringify(relayURL) },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
