const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (n) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n || 0);
const eur2 = (n) => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(n || 0);
const dt = (s) => s ? new Date(s).toLocaleString("nl-NL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";

const STATUS = {
  nieuw: ["Nieuw", "info"], in_behandeling: ["In behandeling", "warn"], concept_klaar: ["Concept klaar", "accent"],
  verstuurd: ["Verstuurd", "info"], gewonnen: ["Gewonnen", "ok"], verloren: ["Verloren", ""], fout: ["Fout", "err"],
};
const SOURCE = { email: "✉ E-mail", website: "🌐 Website", handmatig: "✎ Handmatig", inkoop: "📦 Inkoop" };
const PRIO = { spoed: "err", hoog: "warn", normaal: "", laag: "" };
const INTEG = { verbonden: ["Verbonden", "ok"], demo: ["Demo", "warn"], fout: ["Fout", "err"], niet_geconfigureerd: ["Niet ingesteld", ""], gepland: ["MVP2", "info"] };
const badge = (map, key) => { const [l, c] = map[key] ?? [key, ""]; return `<span class="badge ${c}">${esc(l)}</span>`; };

let filter = "";
let current = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
  return data;
}
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }

async function loadOverview() {
  const o = await api("/api/overview");
  const c = o.counts;
  const f = o.finance?.value;
  $("#demoBadge").hidden = !o.finance?.demo;
  const tiles = [
    ["Wacht op beoordeling", c.concept_klaar || 0, "concepten klaar"],
    ["In behandeling", (c.in_behandeling || 0) + (c.nieuw || 0), c.fout ? `${c.fout} met fout` : "door de assistent"],
    ["Offertes (eenmalig)", eur(o.pipeline.oneOff), "open + verstuurd, excl. btw"],
    ["Offertes (per maand)", eur(o.pipeline.monthly), "terugkerend, excl. btw"],
    ["Openstaande facturen", f ? eur(f.openInvoicesAmount) : "–", f ? `${f.openInvoicesCount} facturen` : "e-Boekhouden niet gekoppeld"],
    ["Omzet deze maand", f ? eur(f.revenueThisMonth) : "–", f ? `vorige maand ${eur(f.revenueLastMonth)}` : ""],
  ];
  $("#kpis").innerHTML = tiles.map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${esc(s)}</div></div>`).join("");

  $("#invoices").innerHTML = f?.recentInvoices?.length
    ? f.recentInvoices.map((i) => `<li><div>${esc(i.relation)}<div class="detail">${esc(i.number)} · ${esc(i.date)}</div></div><div class="num">${eur2(i.amount)}<div>${i.paid ? '<span class="badge ok">Betaald</span>' : '<span class="badge warn">Open</span>'}</div></div></li>`).join("")
    : `<li class="empty">Nog geen facturen gesynchroniseerd</li>`;

  renderChart(o.perDay);
}

function renderChart(perDay) {
  const days = [...Array(14)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d.toISOString().slice(0, 10); });
  const map = Object.fromEntries(perDay.map((p) => [p.day, p.n]));
  const max = Math.max(1, ...days.map((d) => map[d] || 0));
  const w = 300, h = 120, bw = w / days.length;
  const bars = days.map((d, i) => {
    const n = map[d] || 0, bh = (n / max) * (h - 28);
    return `<g><title>${d}: ${n}</title><rect class="bar" rx="2" x="${i * bw + 3}" y="${h - 16 - bh}" width="${bw - 6}" height="${Math.max(bh, n ? 2 : 0)}"></rect>
      ${n ? `<text x="${i * bw + bw / 2}" y="${h - 20 - bh}" text-anchor="middle">${n}</text>` : ""}
      ${i % 2 === 1 ? `<text x="${i * bw + bw / 2}" y="${h - 3}" text-anchor="middle">${d.slice(8)}</text>` : ""}</g>`;
  }).join("");
  $("#chart").innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Aanvragen per dag">${bars}</svg>`;
}

async function loadRequests() {
  const rows = await api(`/api/requests${filter ? `?status=${filter}` : ""}`);
  $("#reqBody").innerHTML = rows.length ? rows.map((r) => {
    const t = r.quote?.totals;
    const est = t ? [t.oneOffExVat ? eur(t.oneOffExVat) : "", t.monthlyExVat ? `${eur(t.monthlyExVat)}/m` : ""].filter(Boolean).join(" + ") || "–" : "–";
    return `<tr data-id="${r.id}"><td>${dt(r.received_at)}</td><td>${SOURCE[r.source] ?? esc(r.source)}</td>
      <td>${esc(r.company || r.customer_name || r.email || "–")}<div class="detail muted small">${esc(r.company ? r.customer_name ?? "" : "")}</div></td>
      <td class="subject">${esc(r.subject || r.summary || "")}</td>
      <td>${r.priority && r.priority !== "normaal" ? `<span class="badge ${PRIO[r.priority]}">${esc(r.priority)}</span>` : ""}</td>
      <td class="num">${est}</td><td>${badge(STATUS, r.status)}</td></tr>`;
  }).join("") : `<tr><td colspan="7" class="empty">Geen aanvragen</td></tr>`;
}

async function loadIntegrations() {
  const list = await api("/api/integrations");
  $("#integrations").innerHTML = list.map((i) => `<li><div>${esc(i.label)}<div class="detail">${esc(i.detail || "")}</div></div>${badge(INTEG, i.status)}</li>`).join("");
}

async function loadActivity() {
  const list = await api("/api/activity");
  $("#activity").innerHTML = list.length ? list.slice(0, 15).map((a) => `<li><time>${dt(a.at)} · ${esc(a.source)}</time><span class="dot ${esc(a.kind)}"></span>${esc(a.message)}</li>`).join("") : `<li class="empty">Nog geen activiteit</li>`;
}

const refresh = () => Promise.all([loadOverview(), loadRequests(), loadIntegrations(), loadActivity()]).catch((e) => toast(e.message));

// ---------- Detailpaneel ----------
async function openRequest(id) {
  current = await api(`/api/requests/${id}`);
  renderDrawer();
  $("#drawer").hidden = false;
}

function renderDrawer() {
  const r = current, q = r.quote;
  const lines = q?.lines ?? [];
  $("#drawerContent").innerHTML = `
    <div class="muted small">#${r.id} · ${SOURCE[r.source] ?? esc(r.source)} · ${dt(r.received_at)}</div>
    <h2 style="font-size:20px;margin:4px 0 8px">${esc(r.subject || "(geen onderwerp)")}</h2>
    <div>${badge(STATUS, r.status)} ${r.priority ? `<span class="badge ${PRIO[r.priority] ?? ""}">prio: ${esc(r.priority)}</span>` : ""}
      ${r.category ? `<span class="badge">${esc(r.category)}</span>` : ""}
      ${q ? `<span class="badge">inschatting: ${q.estimator === "claude" ? "AI" : "regels"} · zekerheid ${esc(q.confidence)}</span>` : ""}</div>
    ${r.error ? `<div class="alert">${esc(r.error)}</div>` : ""}
    ${r.summary ? `<p>${esc(r.summary)}</p>` : ""}

    <h3>Klant</h3>
    <div class="meta">
      <div><span>Naam</span>${esc(r.customer_name || "–")}</div><div><span>Bedrijf</span>${esc(r.company || "–")}</div>
      <div><span>E-mail</span>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "–"}</div><div><span>Telefoon</span>${esc(r.phone || "–")}</div>
    </div>

    <h3>Originele aanvraag</h3>
    <div class="original">${esc(r.body)}</div>

    <h3>Offerte-inschatting</h3>
    ${lines.length ? `<div class="table-wrap"><table class="lines"><thead><tr><th>Omschrijving</th><th class="num">Aantal</th><th class="num">Prijs</th><th>Facturatie</th><th class="num">Totaal</th></tr></thead><tbody>
      ${lines.map((l, i) => `<tr><td>${esc(l.description)}<div class="muted small">${esc(l.sku ?? "maatwerk")} · ${esc(l.unit)}</div></td>
        <td class="num"><input type="number" step="any" min="0" data-i="${i}" data-f="quantity" value="${l.quantity}"></td>
        <td class="num"><input type="number" step="any" min="0" data-i="${i}" data-f="unitPrice" value="${l.unitPrice}"></td>
        <td>${esc(l.billing)}</td><td class="num">${eur2(l.quantity * l.unitPrice)}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="totals">
        <div><span>Eenmalig excl. btw</span><strong>${eur2(q.totals.oneOffExVat)}</strong></div>
        <div><span>Per maand excl. btw</span><strong>${eur2(q.totals.monthlyExVat)}</strong></div>
        <div><span>Eenmalig incl. btw</span><strong>${eur2(q.totals.oneOffIncVat)}</strong></div>
      </div>` : `<p class="muted">${q ? "Geen offerteregels: deze aanvraag vraagt waarschijnlijk geen offerte (bv. storing of vraag)." : "Nog geen inschatting."}</p>`}
    ${q?.assumptions?.length ? `<h3>Aannames</h3><ul class="notes">${q.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
    ${q?.openQuestions?.length ? `<h3>Vragen aan de klant</h3><ul class="notes">${q.openQuestions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}

    <h3>Conceptantwoord</h3>
    <textarea class="reply" id="reply">${esc(r.reply_draft || "")}</textarea>

    <div class="btnrow">
      <button class="btn primary" data-act="save">Opslaan</button>
      <button class="btn" data-act="outlook">Klaarzetten in Outlook</button>
      <button class="btn" data-act="reprocess">Opnieuw inschatten</button>
      <button class="btn ok" data-act="gewonnen">Gewonnen</button>
      <button class="btn danger" data-act="verloren">Verloren</button>
    </div>`;
}

function collectLines() {
  const lines = structuredClone(current.quote?.lines ?? []);
  document.querySelectorAll(".lines input").forEach((inp) => { lines[inp.dataset.i][inp.dataset.f] = Number(inp.value); });
  return lines;
}

$("#drawerContent").addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  const btn = e.target; btn.disabled = true;
  try {
    const id = current.id;
    if (act === "save") {
      current = await api(`/api/requests/${id}`, { method: "PATCH", body: JSON.stringify({ reply_draft: $("#reply").value, lines: current.quote ? collectLines() : undefined }) });
      toast("Opgeslagen"); renderDrawer();
    } else if (act === "outlook") {
      await api(`/api/requests/${id}`, { method: "PATCH", body: JSON.stringify({ reply_draft: $("#reply").value }) });
      await api(`/api/requests/${id}/outlook-draft`, { method: "POST" });
      toast("Concept staat klaar in Outlook"); current = await api(`/api/requests/${id}`); renderDrawer();
    } else if (act === "reprocess") {
      toast("Bezig met opnieuw inschatten…");
      await api(`/api/requests/${id}/reprocess`, { method: "POST" });
      current = await api(`/api/requests/${id}`); renderDrawer(); toast("Nieuwe inschatting klaar");
    } else {
      current = await api(`/api/requests/${id}`, { method: "PATCH", body: JSON.stringify({ status: act }) });
      toast(`Gemarkeerd als ${act}`); renderDrawer();
    }
    refresh();
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
});
$("#drawerContent").addEventListener("change", (e) => {
  if (e.target.matches(".lines input")) { current.quote.lines = collectLines(); }
});

document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $("#drawer").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#drawer").hidden = true; });
$("#reqBody").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) openRequest(tr.dataset.id).catch((err) => toast(err.message)); });
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  filter = b.dataset.status; loadRequests();
});
$("#btnSync").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try { const r = await api("/api/sync", { method: "POST" }); toast(`Gesynchroniseerd – ${r.newMails} nieuwe e-mail(s)`); await refresh(); }
  catch (err) { toast(err.message); } finally { e.target.disabled = false; }
});
$("#btnNew").addEventListener("click", () => $("#newDialog").showModal());
$("#newForm").addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "ok") return;
  const data = Object.fromEntries(new FormData(e.target));
  try { await api("/api/requests", { method: "POST", body: JSON.stringify(data) }); e.target.reset(); toast("Aanvraag opgeslagen, inschatting wordt gemaakt…"); setTimeout(refresh, 400); }
  catch (err) { toast(err.message); }
});

refresh();
setInterval(refresh, 30_000);
