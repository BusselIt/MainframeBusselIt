# BusselIT Mainframe

Centraal dashboard voor BusselIT. Klantaanvragen uit e-mail (Office 365) en van de website komen hier binnen.
Voor elke aanvraag wordt automatisch een offerte-inschatting en een conceptantwoord gemaakt. Daarnaast toont het
dashboard financiële cijfers uit e-Boekhouden.nl.

```
 Office 365 inbox ──┐                         ┌── Dashboard (aanvragen, KPI's, koppelingen, activiteit)
 busselit.com form ─┼─► Intake ─► AI-offerte ─┤
 Handmatig invoeren ┘   (SQLite)  (Claude /    └── Concept-e-mail klaarzetten in Outlook
                                   regels)
 e-Boekhouden.nl ─────► Facturen, omzet, openstaand ─► Dashboard
 Inkoopplatformen (MVP2) ─► inkoopprijzen/voorraad ─► AI-offerte
```

## Snel starten

```bash
npm install
cp .env.example .env      # DEMO_MODE=true laat voorbeelddata zien
npm start                 # http://localhost:3000
```

Vereist Node.js 22.13 of nieuwer (gebruikt de ingebouwde `node:sqlite`). Gegevens staan in `data/mainframe.db`.

## Wat er in MVP1 zit

| Onderdeel | Status | Waar |
|---|---|---|
| Dashboard met KPI's, aanvragenlijst, detailpaneel, activiteit | ✅ | `public/` |
| Office 365: inbox uitlezen (elke 5 min), aanvragen aanmaken, concept-antwoord in Outlook | ✅ | `src/integrations/office365.ts` |
| e-Boekhouden.nl: openstaande facturen, omzet deze/vorige maand, recente facturen | ✅ | `src/integrations/eboekhouden.ts` |
| Websiteformulieren via webhook | ✅ | `src/integrations/website.ts` |
| Offerte-inschatting met Claude (prijslijst + aannames + vragen + conceptmail) | ✅ | `src/ai/quote.ts` |
| Terugvaloptie zonder AI (trefwoorden → prijslijst) | ✅ | `src/ai/quote.ts` |
| Inkoopplatformen (Copaco, Ingram Micro, TD SYNNEX, …) | 🔜 MVP2 | `src/integrations/procurement.ts` |

**Er wordt nooit automatisch iets naar klanten verstuurd.** Een medewerker controleert de inschatting, past
regels/tekst aan en zet het antwoord als concept in Outlook. Daar druk je zelf op Verzenden.

## Koppelingen instellen

### 1. Prijslijst
Pas `config/pricing.json` aan naar de echte BusselIT-tarieven. De huidige prijzen zijn **voorbeelden**. De AI
gebruikt alleen deze lijst en de uurtarieven. Totalen berekent de software zelf, niet de AI.

### 2. AI offerte-assistent (Claude)
Zet `ANTHROPIC_API_KEY` in `.env` (aan te maken op console.anthropic.com). Standaardmodel: `claude-opus-5-5`.
Zonder sleutel werkt de regel-gebaseerde inschatting.

### 3. Office 365 (Microsoft Graph)
1. Ga naar Entra ID → App-registraties → *Nieuwe registratie* (bv. "BusselIT Mainframe").
2. API-machtigingen → Microsoft Graph → **Application permissions** → `Mail.ReadWrite` → *Beheerderstoestemming verlenen*.
3. Certificaten en geheimen → nieuw clientgeheim.
4. Vul `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` en `MS_MAILBOX` in.
5. Aanbevolen: beperk de app tot alleen deze mailbox met een
   [Application Access Policy](https://learn.microsoft.com/graph/auth-limit-mailbox-access).

Ongelezen mails in de inbox worden aanvragen en daarna als *gelezen* gemarkeerd.

### 4. e-Boekhouden.nl
1. In e-Boekhouden: Beheer → Inrichting → Instellingen → Koppelingen → **API** → token aanmaken.
2. Vul `EBOEKHOUDEN_ACCESS_TOKEN` in.
3. Controleer de veldnamen in `src/integrations/eboekhouden.ts` tegen de actuele Swagger
   (https://api.e-boekhouden.nl/swagger). De koppeling is gebouwd op de REST API v1 en nog niet tegen een echte
   administratie getest.

### 5. Website busselit.com
Stel `WEBSITE_WEBHOOK_SECRET` in en laat het formulier een POST sturen naar:

```
POST https://<mainframe-adres>/api/webhooks/website
Header: X-Webhook-Secret: <geheim>
Body (JSON of form): name, company, email, phone, subject, message
```

Voor WordPress kan dat bijvoorbeeld met de webhook-functie van WPForms, Gravity Forms of "CF7 to Webhook".
Test lokaal:

```bash
curl -X POST localhost:3000/api/webhooks/website -H "X-Webhook-Secret: <geheim>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Jan","email":"jan@voorbeeld.nl","subject":"Offerte","message":"Wij zoeken 8 laptops"}'
```

## Live zetten

- Zet `DEMO_MODE=false` en stel `DASHBOARD_PASSWORD` in (login: `admin`).
- Draai achter HTTPS (bv. een VPS met Caddy/nginx, of Azure App Service). De webhook moet publiek bereikbaar zijn,
  het dashboard bij voorkeur alleen via VPN of met het wachtwoord.
- Maak back-ups van de map `data/`.

## API-overzicht

| Methode | Pad | Doel |
|---|---|---|
| GET | `/api/overview` | KPI's, pipeline, financiën |
| GET | `/api/requests?status=` | Aanvragen |
| GET/PATCH | `/api/requests/:id` | Detail / status, regels, conceptantwoord aanpassen |
| POST | `/api/requests` | Handmatige aanvraag |
| POST | `/api/requests/:id/reprocess` | Opnieuw inschatten |
| POST | `/api/requests/:id/outlook-draft` | Concept in Outlook zetten |
| POST | `/api/sync` | Nu mail + boekhouding ophalen |
| GET | `/api/integrations`, `/api/activity` | Status koppelingen, logboek |
| POST | `/api/webhooks/website` | Websiteformulieren |

## Roadmap

- **MVP2 – Inkoop:** adapters per leverancier (`ProcurementAdapter`) voor actuele inkoopprijzen en voorraad.
  Daarna gebruikt de offerte-assistent marge op inkoopprijs in plaats van de vaste prijslijst. Later ook bestellen.
- Goedgekeurde offertes als factuur/offerte doorzetten naar e-Boekhouden.
- Gebruikersaccounts per medewerker (Microsoft-login via Entra ID).
