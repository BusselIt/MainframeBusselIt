/**
 * MVP2 – Inkoopplatformen (bv. Copaco, Ingram Micro, TD SYNNEX, Centralpoint/Signpost).
 * Elke leverancier krijgt een adapter met dezelfde interface; de offerte-assistent kan dan
 * actuele inkoopprijzen en voorraad gebruiken in plaats van de vaste prijslijst.
 */
export interface SupplierOffer { supplier: string; sku: string; description: string; costPrice: number; stock: number; deliveryDays: number }

export interface ProcurementAdapter {
  name: string;
  isConfigured(): boolean;
  search(query: string): Promise<SupplierOffer[]>;
  // later: placeOrder(...), orderStatus(...)
}

export const adapters: ProcurementAdapter[] = [];

export async function searchAll(query: string, marginPct = 15) {
  const results = await Promise.allSettled(adapters.filter(a => a.isConfigured()).map(a => a.search(query)));
  return results.flatMap(r => (r.status === "fulfilled" ? r.value : []))
    .map(o => ({ ...o, sellPrice: Math.round(o.costPrice * (1 + marginPct / 100) * 100) / 100 }))
    .sort((a, b) => a.costPrice - b.costPrice);
}
