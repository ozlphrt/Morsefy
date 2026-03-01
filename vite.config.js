import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
    base: '/Morsefy/',
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            manifest: {
                name: 'Morsefy Tactical',
                short_name: 'Morsefy',
                description: 'Photorealistic Morse Code Trainer',
                theme_color: '#1a1c1e',
                background_color: '#1a1c1e',
                display: 'standalone',
                icons: [
                    {
                        src: 'pwa-192x192.svg',
                        sizes: '192x192',
                        type: 'image/svg+xml'
                    },
                    {
                        src: 'pwa-512x512.svg',
                        sizes: '512x512',
                        type: 'image/svg+xml'
                    },
                    {
                        src: 'pwa-512x512.svg',
                        sizes: '512x512',
                        type: 'image/svg+xml',
                        purpose: 'any maskable'
                    }
                ]
            }
        })
    ]
})
