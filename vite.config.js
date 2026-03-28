import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/csfloat': {
        target: 'https://csfloat.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/csfloat/, '/api/v1'),
      }
    }
  }
})
