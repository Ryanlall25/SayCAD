/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ isSsrBuild }) => ({
  // The crown module's Node bundle (npm run build:module) ships code only.
  publicDir: isSsrBuild ? false : 'public',
  // `./` for the claude.ai artifact build (served from a sub-path), `/` otherwise.
  base: process.env.SAYCAD_BASE ?? '/',
  plugins: [react()],
  // The SayCAD server (server/index.mjs) owns the Claude endpoints.
  server: { host: true, proxy: { '/api': 'http://localhost:8787' } },
  worker: { format: 'es' },
  test: { environment: 'jsdom', testTimeout: 60000 }
}))
