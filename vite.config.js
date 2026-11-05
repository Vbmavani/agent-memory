import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { deepseekApi } from './server/api.js'

export default defineConfig({
  plugins: [react(), deepseekApi],
  server: {
    port: 9200,
    host: '127.0.0.1',
    watch: { ignored: ['**/data/**'] }, // saving chats must not reload the page
  },
})
