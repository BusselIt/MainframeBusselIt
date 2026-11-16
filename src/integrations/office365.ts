/**
 * Office 365 koppeling via Microsoft Graph (client-credentials / app-only).
 * Vereist een app-registratie in Entra ID met application permission "Mail.ReadWrite" + admin consent.
 * Tip: beperk de app tot één mailbox met een Exchange Application Access Policy.
 */
import { config } from "../config.js";
import { logActivity, setIntegrationState } from "../db.js";
import { ingestRequest } from "../pipeline.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
let token: { value: string; expires: number } | null = null;

export const isConfigured = () => {
  const m = config.microsoft;
  return Boolean(m.tenantId && m.clientId && m.clientSecret && m.mailbox);
};

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expires) return token.value;
  const m = config.microsoft;
  const res = await fetch(`https://login.microsoftonline.com/${m.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: m.clientId, client_secret: m.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Token ophalen mislukt (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return token.value;
}

async function graph<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Graph ${init.method ?? "GET"} ${path.split("?")[0]} mislukt (${res.status}): ${await res.text()}`);
  return (res.status === 204 || res.status === 202 ? undefined : await res.json()) as T;
}

interface GraphMessage {
  id: string; subject: string; receivedDateTime: string;
  from?: { emailAddress: { name: string; address: string } };
  body: { contentType: string; content: string };
}

const htmlToText = (html: string) => html
  .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n")
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\n{3,}/g, "\n\n").trim();

/** Haalt ongelezen berichten uit de inbox, zet ze om naar aanvragen en markeert ze als gelezen. */
export async function pollInbox(): Promise<number> {
  if (!isConfigured()) { setIntegrationState("office365", "niet_geconfigureerd", "MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET / MS_MAILBOX ontbreken"); return 0; }
  const mailbox = encodeURIComponent(config.microsoft.mailbox);
  try {
    const list = await graph<{ value: GraphMessage[] }>(
      `/users/${mailbox}/mailFolders/inbox/messages?$filter=isRead eq false&$top=25&$orderby=receivedDateTime asc&$select=id,subject,receivedDateTime,from,body`);
    let created = 0;
    for (const msg of list.value) {
      const body = msg.body.contentType === "html" ? htmlToText(msg.body.content) : msg.body.content;
      const id = await ingestRequest({
        source: "email", externalId: msg.id, receivedAt: msg.receivedDateTime, subject: msg.subject, body,
        customerName: msg.from?.emailAddress.name ?? null, email: msg.from?.emailAddress.address ?? null,
      });
      if (id) created++;
      await graph(`/users/${mailbox}/messages/${msg.id}`, { method: "PATCH", body: JSON.stringify({ isRead: true }) });
    }
    setIntegrationState("office365", "verbonden", `${config.microsoft.mailbox} – ${created} nieuw bij laatste controle`);
    return created;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setIntegrationState("office365", "fout", msg);
    logActivity("fout", "office365", msg);
    return 0;
  }
}

/**
 * Zet het (bewerkte) conceptantwoord klaar als concept in Outlook.
 * Bewust een concept en geen directe verzending: een medewerker drukt zelf op "Verzenden".
 */
export async function createReplyDraft(opts: { messageId?: string | null; to?: string | null; subject: string; body: string }): Promise<string> {
  const mailbox = encodeURIComponent(config.microsoft.mailbox);
  const html = opts.body.split("\n").map(l => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("<br>");
  if (opts.messageId) {
    const draft = await graph<{ id: string }>(`/users/${mailbox}/messages/${opts.messageId}/createReply`, { method: "POST", body: "{}" });
    await graph(`/users/${mailbox}/messages/${draft.id}`, { method: "PATCH", body: JSON.stringify({ body: { contentType: "HTML", content: html } }) });
    return draft.id;
  }
  if (!opts.to) throw new Error("Geen e-mailadres van de klant bekend");
  const draft = await graph<{ id: string }>(`/users/${mailbox}/messages`, {
    method: "POST",
    body: JSON.stringify({ subject: opts.subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: opts.to } }] }),
  });
  return draft.id;
}
