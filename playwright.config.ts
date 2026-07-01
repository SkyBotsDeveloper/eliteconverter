import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  expect: {
    timeout: 7000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "corepack pnpm --filter @eliteconverter/web exec vite --host 127.0.0.1 --port 5173 --mode test",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  projects: [
    { name: "chromium-320", use: { viewport: { width: 320, height: 740 } } },
    { name: "chromium-360", use: { viewport: { width: 360, height: 780 } } },
    { name: "chromium-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "chromium-430", use: { viewport: { width: 430, height: 932 } } },
    { name: "chromium-768", use: { viewport: { width: 768, height: 1024 } } },
    { name: "chromium-1024", use: { viewport: { width: 1024, height: 768 } } },
    { name: "chromium-1280", use: { viewport: { width: 1280, height: 800 } } },
    { name: "chromium-1440", use: { viewport: { width: 1440, height: 900 } } },
    { name: "chromium-1920", use: { viewport: { width: 1920, height: 1080 } } },
  ],
});
