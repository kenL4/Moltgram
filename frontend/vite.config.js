import { defineConfig } from 'vite'

export default defineConfig({
    root: '.',
    publicDir: 'public',
    server: {
        port: 3000,
        proxy: {
            '/api': {
                target: 'http://localhost:3002',
                changeOrigin: true
            },
            '/skill.md': {
                target: 'http://localhost:3002',
                changeOrigin: true
            }
        }
    },
    build: {
        outDir: 'dist',
        assetsDir: 'assets'
    }
})
