/**
 * Offerte-inschatting voor binnenkomende klantaanvragen.
 *
 * - Met ANTHROPIC_API_KEY: Claude analyseert de aanvraag, kiest regels uit de prijslijst
 *   (config/pricing.json) en schrijft een conceptantwoord. Totalen worden hier in code berekend,
 *   niet door het model.
 * - Zonder sleutel (of bij een fout): eenvoudige regel-gebaseerde inschatting op trefwoorden.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config, loadPricing, type Pricing } from "../config.js";

export const QuoteDraftSchema = z.object({
  category: z.enum(["managed-services", "licenties", "hardware", "netwerk", "projecten", "security", "support", "overig"]),
  priority: z.enum(["laag", "normaal", "hoog", "spoed"]),
  summary: z.string().describe("Samenvatting van de aanvraag in 1-2 zinnen, Nederlands"),
  customer: z.object({
    name: z.string().nullable(),
    company: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  lines: z.array(z.object({
    sku: z.string().nullable().describe("SKU uit de prijslijst, of null voor maatwerk/uren"),
    description: z.string(),
    quantity: z.number(),
    unit: z.string(),
    unitPrice: z.number().describe("Prijs per eenheid excl. btw in EUR"),
    billing: z.enum(["eenmalig", "maandelijks"]),
  })),
  assumptions: z.array(z.string()).describe("Aannames die gemaakt zijn voor deze inschatting"),
  openQuestions: z.array(z.string()).describe("Vragen die aan de klant gesteld moeten worden"),
  confidence: z.enum(["laag", "midden", "hoog"]),
  replyDraft: z.string().describe("Conceptantwoord-e-mail aan de klant in het Nederlands, zakelijk en vriendelijk, zonder bedragen te beloven als 'definitief'"),
});
export type QuoteDraft = z.infer<typeof QuoteDraftSchema>;

export interface QuoteTotals { oneOffExVat: number; monthlyExVat: number; vat: number; oneOffIncVat: number; monthlyIncVat: number }
export interface PreparedQuote extends QuoteDraft { totals: QuoteTotals; estimator: "claude" | "regels"; model?: string }

export interface IncomingRequest {
  source: string;
  subject?: string | null;
  body: string;
  customerName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeTotals(lines: QuoteDraft["lines"], vatRate: number): QuoteTotals {
  const oneOff = lines.filter(l => l.billing === "eenmalig").reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const monthly = lines.filter(l => l.billing === "maandelijks").reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  return {
    oneOffExVat: round2(oneOff),
    monthlyExVat: round2(monthly),
    vat: round2((oneOff + monthly) * vatRate),
    oneOffIncVat: round2(oneOff * (1 + vatRate)),
    monthlyIncVat: round2(monthly * (1 + vatRate)),
  };
}

function systemPrompt(pricing: Pricing): string {
  // Stabiel (geen datum/ID's) zodat de prompt gecachet kan worden.
  return `Je bent de offerte-assistent van BusselIT, een IT-dienstverlener voor het MKB in Nederland.
Je krijgt een binnengekomen klantaanvraag (e-mail of websiteformulier). Bereid een offerte-inschatting voor
die een medewerker van BusselIT daarna controleert en verstuurt. Jij verstuurt niets zelf.

Werkwijze:
- Haal klantgegevens uit de tekst als die erin staan; anders null. Verzin geen gegevens.
- Kies offerteregels uit de prijslijst hieronder en gebruik de SKU en prijs uit de lijst.
- Voor werk dat niet in de lijst staat: gebruik een uurtarief uit de lijst, sku null, en schat het aantal uren realistisch.
- Terugkerende diensten (per maand) krijgen billing "maandelijks", al het andere "eenmalig".
- Als het aantal (gebruikers, laptops, ...) onduidelijk is: maak een redelijke aanname, zet die bij assumptions en stel een vraag in openQuestions.
- Geen offerte nodig (bv. storing, factuurvraag, spam)? Geef dan lege lines, categorie "support" of "overig", en een passend conceptantwoord.
- Prioriteit "spoed" alleen bij acute storingen of expliciete haast.
- Het conceptantwoord noemt de inschatting indicatief, vat de voorgestelde oplossing samen en stelt de openstaande vragen.
  Ondertekening: "Met vriendelijke groet,\\nTeam BusselIT".

Prijslijst (${pricing.currency}, excl. btw):
Uurtarieven: ${JSON.stringify(pricing.hourlyRates)}
Catalogus:
${pricing.catalog.map(c => `- ${c.sku} | ${c.name} | ${c.price} per ${c.unit} | ${c.category}`).join("\n")}`;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!config.ai.apiKey) return null;
  client ??= new Anthropic({ apiKey: config.ai.apiKey });
  return client;
}

async function estimateWithClaude(req: IncomingRequest, pricing: Pricing): Promise<PreparedQuote | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  const userText = [
    `Bron: ${req.source}`,
    req.subject ? `Onderwerp: ${req.subject}` : null,
    req.customerName ? `Naam (opgegeven): ${req.customerName}` : null,
    req.company ? `Bedrijf (opgegeven): ${req.company}` : null,
    req.email ? `E-mail (opgegeven): ${req.email}` : null,
    req.phone ? `Telefoon (opgegeven): ${req.phone}` : null,
    "",
    "<aanvraag>",
    req.body,
    "</aanvraag>",
  ].filter(x => x !== null).join("\n");

  const response = await anthropic.beta.messages.parse({
    model: config.ai.model,
    max_tokens: 16000,
    // Bij een weigering door het model probeert de API automatisch een passend fallback-model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(QuoteDraftSchema) },
    system: [{ type: "text", text: systemPrompt(pricing), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
  });

  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error(`Claude gaf geen bruikbare inschatting (stop_reason: ${response.stop_reason})`);
  }
  const draft = response.parsed_output;
  return { ...draft, totals: computeTotals(draft.lines, pricing.vatRate), estimator: "claude", model: response.model };
}

/** Eenvoudige terugvaloptie zonder AI: trefwoorden -> prijslijstregels. */
export function estimateWithRules(req: IncomingRequest, pricing: Pricing): PreparedQuote {
  const text = `${req.subject ?? ""} ${req.body}`.toLowerCase();
  const num = (re: RegExp, d: number) => { const m = text.match(re); return m ? Number(m[1]) : d; };
  const users = num(/(\d+)\s*(?:medewerkers|gebruikers|personen|werkplekken|mensen|collega)/, 0);
  const item = (sku: string) => pricing.catalog.find(c => c.sku === sku)!;
  const lines: QuoteDraft["lines"] = [];
  const assumptions: string[] = ["Automatische inschatting op basis van trefwoorden (geen AI-sleutel ingesteld)."];
  const add = (sku: string, qty: number, billing: "eenmalig" | "maandelijks") => {
    const c = item(sku); if (c) lines.push({ sku, description: c.name, quantity: qty, unit: c.unit, unitPrice: c.price, billing });
  };
  const urgent = /spoed|storing|ligt plat|werkt niet|dringend|asap/.test(text);
  const wantsQuote = /offerte|prijs|aanschaf|nieuwe?|zoeken|willen|graag|overstap|uitbreid|doorlicht/.test(text);
  const n = users || 5;
  if (!users && !(urgent && !wantsQuote)) assumptions.push("Aantal gebruikers niet gevonden; uitgegaan van 5.");

  let category: QuoteDraft["category"] = "overig";
  if (/laptop|notebook/.test(text)) { add("LAPTOP-STD", num(/(\d+)\s*(?:laptops?|notebooks?)/, n), "eenmalig"); add("WERKPLEK-INR", num(/(\d+)\s*(?:laptops?|notebooks?)/, n), "eenmalig"); category = "hardware"; }
  if (/monitor|scherm/.test(text)) { add("MONITOR-27", num(/(\d+)\s*(?:monitors?|schermen)/, n), "eenmalig"); category = "hardware"; }
  if (/365|office|outlook|teams|licentie/.test(text)) { add("M365-BP", n, "maandelijks"); category = category === "overig" ? "licenties" : category; }
  if (/migrat|overstap|overzetten/.test(text)) { add("M365-MIGR", n, "eenmalig"); category = "projecten"; }
  if (/back-?up/.test(text)) add("BACKUP-M365", n, "maandelijks");
  if (/wifi|wi-fi|draadloos|netwerk/.test(text)) { add("WIFI-AP", 2, "eenmalig"); category = "netwerk"; assumptions.push("Uitgegaan van 2 access points."); }
  if (/firewall|beveilig|security|hack|phishing/.test(text)) { add("SEC-SCAN", 1, "eenmalig"); category = "security"; }
  if (/beheer|onderhoud|ontzorg/.test(text)) { add("MW-BEHEER", n, "maandelijks"); category = "managed-services"; }
  if (urgent && !wantsQuote) { lines.length = 0; category = "support"; assumptions.push("Lijkt een storing; geen offerte nodig."); }

  const name = req.customerName ?? null;
  const replyDraft = `Beste ${name ?? "heer/mevrouw"},

Hartelijk dank voor uw aanvraag${req.subject ? ` "${req.subject}"` : ""}. ${lines.length
    ? "Op basis van uw bericht hebben wij een eerste, indicatieve inschatting gemaakt. Wij nemen deze graag met u door en stemmen de details af."
    : "Wij hebben uw bericht in goede orde ontvangen en nemen zo spoedig mogelijk contact met u op."}

Met vriendelijke groet,
Team BusselIT`;

  return {
    category,
    priority: urgent ? "spoed" : "normaal",
    summary: (req.subject || req.body.slice(0, 140)).trim(),
    customer: { name, company: req.company ?? null, email: req.email ?? null, phone: req.phone ?? null },
    lines,
    assumptions,
    openQuestions: users || !lines.length ? [] : ["Met hoeveel gebruikers/werkplekken werkt u?"],
    confidence: "laag",
    replyDraft,
    totals: computeTotals(lines, pricing.vatRate),
    estimator: "regels",
  };
}

export async function prepareQuote(req: IncomingRequest): Promise<PreparedQuote> {
  const pricing = loadPricing();
  try {
    const ai = await estimateWithClaude(req, pricing);
    if (ai) return ai;
  } catch (err) {
    const result = estimateWithRules(req, pricing);
    result.assumptions.unshift(`AI-inschatting mislukt (${err instanceof Error ? err.message : String(err)}); regel-gebaseerde inschatting gebruikt.`);
    return result;
  }
  return estimateWithRules(req, pricing);
}
