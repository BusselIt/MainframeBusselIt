/** Centrale intake: elke bron (e-mail, website, handmatig, later inkoop) komt hier binnen. */
import { db, logActivity, now } from "./db.js";
import { prepareQuote, type IncomingRequest } from "./ai/quote.js";

export interface IntakeInput extends IncomingRequest {
  externalId?: string | null;
  receivedAt?: string;
}

/** Slaat een aanvraag op (dubbele berichten worden genegeerd) en start de offertevoorbereiding. */
export async function ingestRequest(input: IntakeInput, opts: { wait?: boolean } = {}): Promise<number | null> {
  const ts = now();
  const res = db.prepare(`
    INSERT OR IGNORE INTO requests (source, external_id, received_at, customer_name, company, email, phone, subject, body, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_behandeling', ?)`).run(
    input.source, input.externalId ?? null, input.receivedAt ?? ts,
    input.customerName ?? null, input.company ?? null, input.email ?? null, input.phone ?? null,
    input.subject ?? null, input.body, ts);
  if (res.changes === 0) return null; // al bekend
  const id = Number(res.lastInsertRowid);
  logActivity("info", input.source, `Nieuwe aanvraag #${id}: ${input.subject ?? "(geen onderwerp)"}`);

  const job = prepareRequest(id);
  if (opts.wait) await job; else job.catch(() => {});
  return id;
}

export async function prepareRequest(id: number): Promise<void> {
  const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, string | null> | undefined;
  if (!row) return;
  db.prepare("UPDATE requests SET status='in_behandeling', error=NULL, updated_at=? WHERE id=?").run(now(), id);
  try {
    const q = await prepareQuote({
      source: row.source!, subject: row.subject, body: row.body ?? "",
      customerName: row.customer_name, company: row.company, email: row.email, phone: row.phone,
    });
    db.prepare(`UPDATE requests SET status='concept_klaar', priority=?, category=?, summary=?, quote_json=?, reply_draft=?, estimator=?,
                customer_name=COALESCE(customer_name, ?), company=COALESCE(company, ?), email=COALESCE(email, ?), phone=COALESCE(phone, ?),
                updated_at=? WHERE id=?`).run(
      q.priority, q.category, q.summary, JSON.stringify(q), q.replyDraft, q.estimator,
      q.customer.name, q.customer.company, q.customer.email, q.customer.phone, now(), id);
    const total = q.totals.oneOffExVat ? `€ ${q.totals.oneOffExVat.toFixed(2)} eenmalig` : "";
    const monthly = q.totals.monthlyExVat ? `€ ${q.totals.monthlyExVat.toFixed(2)} p/m` : "";
    logActivity("succes", "offerte", `Concept klaar voor #${id} (${q.estimator}) ${[total, monthly].filter(Boolean).join(" + ")}`.trim());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE requests SET status='fout', error=?, updated_at=? WHERE id=?").run(msg, now(), id);
    logActivity("fout", "offerte", `Voorbereiden #${id} mislukt: ${msg}`);
  }
}
