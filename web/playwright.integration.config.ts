import base from './playwright.config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'
// Explicit opt-in: an absent checkout is a configuration failure, never a skipped green test.
process.env.CLIPMENTOR_TEST_SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))
if (!existsSync(join(process.env.CLIPMENTOR_TEST_SOURCE_ROOT, 'server/clipmentor/production-web-loop.test-server.ts'))) throw new Error('CLIPMENTOR_TEST_SOURCE_ROOT must contain the production web-loop test server')
process.env.CLIPMENTOR_WEB_TEST_UI_PORT = new URL(base.use!.baseURL!).port
export default defineConfig(base, { testDir: './tests/integration', fullyParallel: false, workers: 1, timeout: 90_000 })
