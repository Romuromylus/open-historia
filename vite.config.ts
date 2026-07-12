/*! Open Historia — portions (dev API proxy + vendor chunks) © 2026 Nicholas Krol, MIT (see src/Editor/LICENSE). */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Short build stamp for deploy diagnosis: the 7-char Git SHA the image was
  // built from (EasyPanel passes GIT_SHA; the Dockerfile exports it into the
  // build env), else "dev" for a local build. Logged once at client startup and
  // rendered as tiny muted text at the bottom of the timeline panel.
  define: {
    __PAX_BUILD__: JSON.stringify(process.env.GIT_SHA?.slice(0, 7) || "dev"),
  },
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
  ],
  // Proxy API calls to the Express server during `npm run dev` so the map editor's
  // save/load (and the game's runtime endpoints) work with hot-reload too.
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-maplibre': ['maplibre-gl'],
          'vendor-chartjs': ['chart.js'],
          'vendor-ol': ['ol'],
        },
      },
    },
  },
})
