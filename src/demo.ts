/** Voorbeelddata zodat het dashboard direct iets laat zien (DEMO_MODE=true). */
import { db, logActivity, setIntegrationState } from "./db.js";
import { ingestRequest } from "./pipeline.js";

const samples = [
  { source: "email", subject: "Offerte nieuwe laptops", customerName: "Sanne de Vries", company: "Bakkerij Verhoeven", email: "sanne@bakkerijverhoeven.nl",
    body: "Hallo BusselIT,\n\nWij willen graag 6 nieuwe laptops voor ons kantoorpersoneel, inclusief installatie. Kunnen jullie ook de Microsoft 365 licenties regelen voor 6 gebruikers? Graag een offerte.\n\nGroet, Sanne" },
  { source: "website", subject: "Wifi op kantoor valt steeds weg", customerName: "Mark Jansen", company: "Installatiebedrijf Jansen", email: "mark@jansen-installatie.nl", phone: "06-12345678",
    body: "Ons wifi netwerk op kantoor (2 verdiepingen, 15 medewerkers) is heel onstabiel. We zoeken een oplossing met goede dekking en eventueel een nieuwe firewall." },
  { source: "email", subject: "SPOED: mail werkt niet", customerName: "Ilse Bakker", company: "Tandartspraktijk Smile", email: "ilse@smile-tandarts.nl",
    body: "Sinds vanochtend werkt Outlook bij niemand meer. Dringend, de praktijk draait vol!" },
  { source: "website", subject: "Overstap naar Microsoft 365 en beheer", customerName: "Pieter de Wit", company: "Advocatenkantoor De Wit", email: "p.dewit@dewit-advocaten.nl",
    body: "Wij werken nu met een oude Exchange-server en willen met 12 medewerkers overstappen naar Microsoft 365, inclusief back-up. Daarna zoeken we iemand die het beheer van onze werkplekken overneemt." },
  { source: "email", subject: "Security check na phishing mail", customerName: "Fatima El Amrani", company: "Kinderopvang Zonnestraal", email: "fatima@zonnestraal.nl",
    body: "Een collega heeft op een phishing link geklikt. Kunnen jullie onze beveiliging eens doorlichten? We zijn met 20 medewerkers." },
];

export async function seedDemo() {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n;
  if (count > 0) return;
  const t = Date.now();
  for (const [i, s] of samples.entries()) {
    await ingestRequest({ ...s, externalId: `demo-${i}`, receivedAt: new Date(t - (samples.length - i) * 47 * 60_000).toISOString() }, { wait: true });
  }
  db.prepare("UPDATE requests SET status='verstuurd' WHERE external_id='demo-3'").run();
  setIntegrationState("e-boekhouden", "demo", "Voorbeelddata – stel EBOEKHOUDEN_ACCESS_TOKEN in");
  setIntegrationState("office365", "demo", "Voorbeelddata – stel Microsoft Graph-gegevens in");
  setIntegrationState("website", "demo", "Wacht op eerste formulier van busselit.com");
  logActivity("info", "systeem", "Demodata geladen");
}
