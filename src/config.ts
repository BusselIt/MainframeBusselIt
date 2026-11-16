import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const env = (k: string, d = "") => (process.env[k] ?? d).trim();

export const config = {
  port: Number(env("PORT", "3000")),
  dashboardPassword: env("DASHBOARD_PASSWORD"),
  demoMode: env("DEMO_MODE", "true").toLowerCase() === "true",
  dataDir: path.resolve("data"),
  ai: {
    apiKey: env("ANTHROPIC_API_KEY"),
    model: env("CLAUDE_MODEL", "claude-opus-5-5"),
  },
  eboekhouden: {
    accessToken: env("EBOEKHOUDEN_ACCESS_TOKEN"),
    source: env("EBOEKHOUDEN_SOURCE", "BusselITMainframe"),
    baseUrl: "https://api.e-boekhouden.nl/v1",
  },
  microsoft: {
    tenantId: env("MS_TENANT_ID"),
    clientId: env("MS_CLIENT_ID"),
    clientSecret: env("MS_CLIENT_SECRET"),
    mailbox: env("MS_MAILBOX"),
    pollMinutes: Number(env("MAIL_POLL_MINUTES", "5")),
  },
  website: {
    webhookSecret: env("WEBSITE_WEBHOOK_SECRET"),
  },
};

export interface CatalogItem { sku: string; name: string; unit: string; price: number; category: string }
export interface Pricing {
  currency: string;
  vatRate: number;
  hourlyRates: Record<string, number>;
  catalog: CatalogItem[];
}

export function loadPricing(): Pricing {
  return JSON.parse(fs.readFileSync(path.resolve("config/pricing.json"), "utf8"));
}
