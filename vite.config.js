import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { deepseekApi } from './server/api.js'
import { guardrailsApi } from './server/guardrails/api.js'

export default defineConfig({
  plugins: [react(), guardrailsApi, deepseekApi], // guardrailsApi first: /api/guardrails needs no database
  build: { rollupOptions: { input: { main: 'index.html', vectors: 'vectors.html', graph: 'graph.html', guardrails: 'guardrails.html' } } }, // four pages
  server: {
    port: 9200,
    host: '127.0.0.1',
    watch: { ignored: ['**/data/**'] }, // saving chats must not reload the page
  },
})
