/**
 * Koppeling met formulieren op busselit.com.
 * De website stuurt een POST naar /api/webhooks/website met header  X-Webhook-Secret: <WEBSITE_WEBHOOK_SECRET>
 * Body (JSON of form-urlencoded):  { name, company, email, phone, subject, message, formId?, submissionId? }
 * Werkt met o.a. WordPress (Contact Form 7 / Gravity Forms / WPForms webhook-add-ons), Webflow, Wix of een eigen formulier.
 */
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { logActivity, setIntegrationState } from "../db.js";
import { ingestRequest } from "../pipeline.js";

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) { const v = o[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
  return null;
};

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export async function websiteWebhook(req: Request, res: Response) {
  const secret = config.website.webhookSecret;
  if (!secret) return res.status(503).json({ error: "WEBSITE_WEBHOOK_SECRET is niet ingesteld" });
  if (!safeEqual(String(req.header("x-webhook-secret") ?? ""), secret)) return res.status(401).json({ error: "Ongeldig geheim" });

  const b = (req.body ?? {}) as Record<string, unknown>;
  const message = pick(b, "message", "bericht", "body", "omschrijving", "your-message");
  if (!message) return res.status(400).json({ error: "Veld 'message' ontbreekt" });

  const id = await ingestRequest({
    source: "website",
    externalId: pick(b, "submissionId", "id", "entry_id"),
    subject: pick(b, "subject", "onderwerp", "your-subject") ?? "Aanvraag via website",
    body: message,
    customerName: pick(b, "name", "naam", "your-name"),
    company: pick(b, "company", "bedrijf", "bedrijfsnaam"),
    email: pick(b, "email", "e-mail", "your-email"),
    phone: pick(b, "phone", "telefoon", "tel"),
  });
  setIntegrationState("website", "verbonden", "Laatste formulier ontvangen");
  if (id) logActivity("info", "website", `Formulier ontvangen -> aanvraag #${id}`);
  res.status(202).json({ ok: true, id, duplicate: id === null });
}
