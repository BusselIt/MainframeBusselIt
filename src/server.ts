import express, { type NextFunction, type Request, type Response } from "express";
import crypto from "node:crypto";
import path from "node:path";
import { config, loadPricing } from "./config.js";
import { db, logActivity, now, setIntegrationState, cacheGet } from "./db.js";
import { ingestRequest, prepareRequest } from "./pipeline.js";
import * as eboekhouden from "./integrations/eboekhouden.js";
import * as office365 from "./integrations/office365.js";
import { websiteWebhook } from "./integrations/website.js";
import { computeTotals, type PreparedQuote } from "./ai/quote.js";
import { seedDemo } from "./demo.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Webhook van de website: eigen geheim, geen dashboard-login.
app.post("/api/webhooks/website", (req, res, next) => websiteWebhook(req, res).catch(next));

// Dashboard-login (HTTP Basic, gebruiker "admin").
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!config.dashboardPassword) return next();
  const [type, value] = (req.header("authorization") ?? "").split(" ");
  const pass = type === "Basic" && value ? Buffer.from(value, "base64").toString().split(":").slice(1).join(":") : "";
  const a = Buffer.from(pass), b = Buffer.from(config.dashboardPassword);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set("WWW-Authenticate", 'Basic realm="BusselIT Mainframe"').status(401).send("Inloggen vereist");
});

app.use(express.static(path.resolve("public")));

type Row = Record<string, unknown> & { quote_json?: string | null };
const parseRow = (r: Row) => ({ ...r, quote: r.quote_json ? JSON.parse(r.quote_json) : null, quote_json: undefined });

app.get("/api/overview", (_req, res) => {
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM requests GROUP BY status").all() as { status: string; n: number }[];
  const bySource = db.prepare("SELECT source, COUNT(*) AS n FROM requests WHERE received_at >= date('now','-30 day') GROUP BY source").all();
  const open = db.prepare("SELECT quote_json FROM requests WHERE status IN ('concept_klaar','verstuurd') AND quote_json IS NOT NULL").all() as Row[];
  const pipeline = open.reduce((acc, r) => {
    const q = JSON.parse(r.quote_json!) as PreparedQuote;
    acc.oneOff += q.totals.oneOffExVat; acc.monthly += q.totals.monthlyExVat; return acc;
  }, { oneOff: 0, monthly: 0 } as { oneOff: number; monthly: number });
  const perDay = db.prepare(`SELECT substr(received_at,1,10) AS day, COUNT(*) AS n FROM requests
                             WHERE received_at >= date('now','-13 day') GROUP BY day ORDER BY day`).all();
  const finance = config.demoMode && !eboekhouden.isConfigured()
    ? { value: eboekhouden.demoFinance(), updatedAt: now(), demo: true }
    : { ...(cacheGet("finance") ?? { value: null, updatedAt: null }), demo: false };
  res.json({ counts: Object.fromEntries(counts.map(c => [c.status, c.n])), bySource, pipeline, perDay, finance });
});

app.get("/api/requests", (req, res) => {
  const status = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
  const rows = (status
    ? db.prepare("SELECT * FROM requests WHERE status = ? ORDER BY received_at DESC LIMIT 200").all(status)
    : db.prepare("SELECT * FROM requests ORDER BY received_at DESC LIMIT 200").all()) as Row[];
  res.json(rows.map(parseRow));
});

app.get("/api/requests/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(Number(req.params.id)) as Row | undefined;
  row ? res.json(parseRow(row)) : res.status(404).json({ error: "Niet gevonden" });
});

// Handmatig een aanvraag invoeren (bv. telefonisch)
app.post("/api/requests", async (req, res) => {
  const b = req.body ?? {};
  if (!b.body) return res.status(400).json({ error: "Omschrijving ontbreekt" });
  const id = await ingestRequest({ source: "handmatig", subject: b.subject, body: b.body, customerName: b.customerName, company: b.company, email: b.email, phone: b.phone });
  res.status(201).json({ id });
});

// Status, conceptantwoord of offerteregels aanpassen
app.patch("/api/requests/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Row | undefined;
  if (!row) return res.status(404).json({ error: "Niet gevonden" });
  const { status, reply_draft, lines } = req.body ?? {};
  const allowed = ["nieuw", "in_behandeling", "concept_klaar", "verstuurd", "gewonnen", "verloren", "fout"];
  if (status && !allowed.includes(status)) return res.status(400).json({ error: "Ongeldige status" });
  let quoteJson = row.quote_json ?? null;
  if (Array.isArray(lines) && quoteJson) {
    const q = JSON.parse(quoteJson) as PreparedQuote;
    q.lines = lines; q.totals = computeTotals(lines, loadPricing().vatRate);
    quoteJson = JSON.stringify(q);
  }
  db.prepare("UPDATE requests SET status=COALESCE(?, status), reply_draft=COALESCE(?, reply_draft), quote_json=?, updated_at=? WHERE id=?")
    .run(status ?? null, reply_draft ?? null, quoteJson, now(), id);
  if (status) logActivity("info", "dashboard", `Aanvraag #${id} -> ${status}`);
  res.json(parseRow(db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Row));
});

app.post("/api/requests/:id/reprocess", async (req, res) => {
  await prepareRequest(Number(req.params.id));
  res.json({ ok: true });
});

// Conceptantwoord als concept in Outlook zetten
app.post("/api/requests/:id/outlook-draft", async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, string | null> | undefined;
  if (!row) return res.status(404).json({ error: "Niet gevonden" });
  if (!office365.isConfigured()) return res.status(400).json({ error: "Office 365 is nog niet gekoppeld (zie .env)" });
  try {
    await office365.createReplyDraft({
      messageId: row.source === "email" ? row.external_id : null, to: row.email,
      subject: `Re: ${row.subject ?? "uw aanvraag bij BusselIT"}`, body: row.reply_draft ?? "",
    });
    db.prepare("UPDATE requests SET status='verstuurd', updated_at=? WHERE id=?").run(now(), id);
    logActivity("succes", "office365", `Concept-e-mail voor #${id} klaargezet in Outlook`);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/integrations", (_req, res) => {
  const rows = db.prepare("SELECT * FROM integration_state").all() as { name: string }[];
  const known = new Map(rows.map(r => [r.name, r]));
  const list = [
    { name: "office365", label: "Office 365 (e-mail)", mvp: 1 },
    { name: "e-boekhouden", label: "e-Boekhouden.nl", mvp: 1 },
    { name: "website", label: "busselit.com formulieren", mvp: 1 },
    { name: "claude", label: "AI offerte-assistent", mvp: 1 },
    { name: "inkoop", label: "Inkoopplatformen", mvp: 2 },
  ].map(i => ({ ...i, ...(known.get(i.name) ?? { status: "niet_geconfigureerd", last_sync: null, detail: "" }) }));
  res.json(list);
});

app.post("/api/sync", async (_req, res) => {
  const [mails] = await Promise.all([office365.pollInbox(), eboekhouden.syncFinance()]);
  res.json({ ok: true, newMails: mails });
});

app.get("/api/activity", (_req, res) => {
  res.json(db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 50").all());
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Onbekende fout" });
});

async function start() {
  setIntegrationState("claude", config.ai.apiKey ? "verbonden" : "niet_geconfigureerd",
    config.ai.apiKey ? `Model ${config.ai.model}` : "Geen ANTHROPIC_API_KEY – regel-gebaseerde inschatting actief");
  setIntegrationState("inkoop", "gepland", "MVP2: Copaco / Ingram Micro / TD SYNNEX adapters");
  if (!config.website.webhookSecret) setIntegrationState("website", "niet_geconfigureerd", "WEBSITE_WEBHOOK_SECRET ontbreekt");
  if (config.demoMode) await seedDemo();

  const sync = async () => { await office365.pollInbox(); await eboekhouden.syncFinance(); };
  if (!config.demoMode || office365.isConfigured() || eboekhouden.isConfigured()) {
    sync().catch(console.error);
    setInterval(() => sync().catch(console.error), Math.max(1, config.microsoft.pollMinutes) * 60_000);
  }
  app.listen(config.port, () => console.log(`BusselIT Mainframe draait op http://localhost:${config.port}${config.demoMode ? " (demo-modus)" : ""}`));
}
start();
