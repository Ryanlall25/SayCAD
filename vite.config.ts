/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The SayCAD server (server/index.mjs) owns the Claude endpoints.
  server: { host: true, proxy: { '/api': 'http://localhost:8787' } },
  worker: { format: 'es' },
  test: { environment: 'jsdom', testTimeout: 60000 }
})
