/**
 * e-Boekhouden.nl koppeling (REST API, https://api.e-boekhouden.nl).
 * Flow: POST /v1/session met { accessToken, source } -> sessietoken -> header "Authorization: <token>".
 * Controleer endpoint- en veldnamen tegen de actuele Swagger: https://api.e-boekhouden.nl/swagger
 */
import { config } from "../config.js";
import { cacheGet, cacheSet, logActivity, setIntegrationState } from "../db.js";

export interface FinanceSummary {
  openInvoicesCount: number;
  openInvoicesAmount: number;
  revenueThisMonth: number;
  revenueLastMonth: number;
  recentInvoices: { number: string; relation: string; date: string; amount: number; paid: boolean }[];
}

let session: { token: string; expires: number } | null = null;

async function getSession(): Promise<string> {
  if (session && Date.now() < session.expires) return session.token;
  const res = await fetch(`${config.eboekhouden.baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: config.eboekhouden.accessToken, source: config.eboekhouden.source }),
  });
  if (!res.ok) throw new Error(`Sessie aanmaken mislukt (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { token: string; expiresIn?: number };
  session = { token: data.token, expires: Date.now() + ((data.expiresIn ?? 3600) - 60) * 1000 };
  return session.token;
}

async function api<T>(path: string): Promise<T> {
  const token = await getSession();
  const res = await fetch(`${config.eboekhouden.baseUrl}${path}`, { headers: { Authorization: token, Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} mislukt (${res.status})`);
  return (await res.json()) as T;
}

export const isConfigured = () => Boolean(config.eboekhouden.accessToken);

interface EbInvoice { id: number; invoiceNumber: string; relationId: number; date: string; totalInclVat?: number; totalExclVat?: number; outstanding?: number }
interface EbRelation { id: number; name?: string; company?: string }

export async function syncFinance(): Promise<FinanceSummary | null> {
  if (!isConfigured()) { setIntegrationState("e-boekhouden", "niet_geconfigureerd", "EBOEKHOUDEN_ACCESS_TOKEN ontbreekt"); return null; }
  try {
    const today = new Date();
    const firstThis = new Date(today.getFullYear(), today.getMonth(), 1);
    const firstLast = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const invoicesRes = await api<{ items?: EbInvoice[] } | EbInvoice[]>(`/invoice?date[gte]=${iso(firstLast)}&limit=500`);
    const invoices = Array.isArray(invoicesRes) ? invoicesRes : invoicesRes.items ?? [];
    const relationsRes = await api<{ items?: EbRelation[] } | EbRelation[]>(`/relation?limit=2000`);
    const relations = new Map((Array.isArray(relationsRes) ? relationsRes : relationsRes.items ?? []).map(r => [r.id, r.company || r.name || `Relatie ${r.id}`]));

    const amount = (i: EbInvoice) => i.totalExclVat ?? i.totalInclVat ?? 0;
    const inMonth = (i: EbInvoice, start: Date, end: Date) => { const d = new Date(i.date); return d >= start && d < end; };
    const open = invoices.filter(i => (i.outstanding ?? 0) > 0);

    const summary: FinanceSummary = {
      openInvoicesCount: open.length,
      openInvoicesAmount: open.reduce((s, i) => s + (i.outstanding ?? 0), 0),
      revenueThisMonth: invoices.filter(i => inMonth(i, firstThis, new Date(9e15))).reduce((s, i) => s + amount(i), 0),
      revenueLastMonth: invoices.filter(i => inMonth(i, firstLast, firstThis)).reduce((s, i) => s + amount(i), 0),
      recentInvoices: invoices.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map(i => ({
        number: i.invoiceNumber, relation: relations.get(i.relationId) ?? "-", date: i.date, amount: amount(i), paid: (i.outstanding ?? 0) <= 0,
      })),
    };
    cacheSet("finance", summary);
    setIntegrationState("e-boekhouden", "verbonden", `${invoices.length} facturen gesynchroniseerd`);
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setIntegrationState("e-boekhouden", "fout", msg);
    logActivity("fout", "e-boekhouden", msg);
    return cacheGet<FinanceSummary>("finance")?.value ?? null;
  }
}

export function demoFinance(): FinanceSummary {
  return {
    openInvoicesCount: 7, openInvoicesAmount: 12480.5, revenueThisMonth: 18320, revenueLastMonth: 22145.75,
    recentInvoices: [
      { number: "2026-0412", relation: "Bakkerij Verhoeven", date: "2026-11-14", amount: 1245.0, paid: false },
      { number: "2026-0411", relation: "Advocatenkantoor De Wit", date: "2026-11-12", amount: 3890.0, paid: true },
      { number: "2026-0410", relation: "Installatiebedrijf Jansen", date: "2026-11-10", amount: 640.5, paid: false },
      { number: "2026-0409", relation: "Tandartspraktijk Smile", date: "2026-11-07", amount: 2150.0, paid: true },
      { number: "2026-0408", relation: "Kinderopvang Zonnestraal", date: "2026-11-03", amount: 980.0, paid: false },
    ],
  };
}
