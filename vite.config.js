import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// IMPORTANT: change this to match your GitHub repo name
// e.g. if repo is "artisan-market", base should be "/artisan-market/"
export default defineConfig({
  base: "/mitti-ki-dukan/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon-32.png", "apple-touch-icon.png"],
      manifest: {
        name: "हमारी मिट्टी की दुकान",
        short_name: "मिट्टी की दुकान",
        description: "आपके ज़िले के कारीगरों के असली, घर के बने प्रोडक्ट",
        start_url: "/mitti-ki-dukan/",
        scope: "/mitti-ki-dukan/",
        display: "standalone",
        background_color: "#FBF5EC",
        theme_color: "#A8472E",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        navigateFallbackDenylist: [/^\/__/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin.includes("firestore.googleapis.com"),
            handler: "NetworkOnly",
          },
          {
            urlPattern: ({ url }) => url.origin.includes("res.cloudinary.com"),
            handler: "CacheFirst",
            options: {
              cacheName: "product-images",
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
});
