import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // MapLibre is a single ~1 MB module and is needed on the first screen, so splitting it would not help
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['src/**/*.test.js'],
  },
})
