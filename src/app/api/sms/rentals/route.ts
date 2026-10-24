import { db } from "@/db";
import { orders, rentals, users } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { apiError, AppError, audit, getSettings, IS_DEMO, limit, requireStoreOpen, sameOrigin } from "@/lib/server";
import { getRentQuote, listServices, providerRequest, ProviderError, record, rentLabel, unwrap } from "@/lib/numberotp";
import { refundOrder } from "@/lib/billing";
import { getCurrencyQuote } from "@/lib/fx";
import { fromUsd } from "@/lib/currency";
export const dynamic = "force-dynamic";
export async function GET() { try { const user = await requireUser(); return Response.json({ rentals: await db.select().from(rentals).where(eq(rentals.userId, user.id)).orderBy(desc(rentals.createdAt)).limit(100) }); } catch (e) { return apiError(e); } }
export async function POST(request: Request) {
  try {
    sameOrigin(request); await limit(request, "rental-buy", 10); const user = await requireUser(); await requireStoreOpen();
    const data = z.object({ service: z.string().min(1).max(30), country: z.string().min(1).max(10), countryName: z.string().max(100), hours: z.number().int().min(2).max(720), expectedPrice: z.number().int().nonnegative(), expectedAmount: z.number().int().nonnegative().optional(), expectedCurrency: z.string().length(3).optional(), idempotencyKey: z.string().uuid() }).parse(await request.json());
    const config = await getSettings(); const key = `rental:${user.id}:${data.idempotencyKey}`;
    const [previous] = await db.select().from(orders).where(eq(orders.idempotencyKey, key));
    if (previous) { const [rental] = await db.select().from(rentals).where(eq(rentals.orderId, previous.id)); return Response.json({ rental }); }
    const [quote, services] = await Promise.all([getRentQuote(data.service, data.country, data.hours, config.smsMarkup), listServices()]);
    const service = services.find(s => s.code === data.service); if (!service) throw new AppError("Please choose an available service.");
    if (quote.price !== data.expectedPrice) throw new AppError("The price has changed. Please refresh the rental options and review the new price.", 409);
    const fx = await getCurrencyQuote(user.currency); const amount = fromUsd(quote.price, fx);
    if ((user.currency !== "USD" && (data.expectedAmount == null || data.expectedCurrency !== user.currency)) || (data.expectedAmount != null && data.expectedAmount !== amount) || (data.expectedCurrency && data.expectedCurrency !== user.currency)) throw new AppError("The local price or exchange rate has changed. Refresh and review the amount before renting.", 409);
    const reservation = await db.transaction(async tx => {
      const [wallet] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
      const [duplicate] = await tx.select().from(orders).where(eq(orders.idempotencyKey, key));
      if (duplicate) { const [existing] = await tx.select().from(rentals).where(eq(rentals.orderId, duplicate.id)); return { rental: existing, created: false }; }
      if (!wallet || wallet.suspended || wallet.currency !== user.currency) throw new AppError("Your account is unavailable.", 403);
      if (wallet.balance < amount) throw new AppError("Please top up your wallet before renting this number.", 402);
      await tx.update(users).set({ balance: sql`${users.balance} - ${amount}` }).where(eq(users.id, user.id));
      const [order] = await tx.insert(orders).values({ userId: user.id, kind: "sms", title: `Rental · ${service.name} · ${data.countryName} · ${rentLabel(data.hours)}`, amount, currency: user.currency, baseAmount: quote.price, status: "processing", idempotencyKey: key, metadata: { rental: true, service: data.service, country: data.country, hours: data.hours, demo: IS_DEMO, fx } }).returning();
      const [rental] = await tx.insert(rentals).values({ userId: user.id, orderId: order.id, service: data.service, serviceName: service.name, country: data.country, countryName: data.countryName, durationHours: data.hours, price: amount, currency: user.currency, providerCost: quote.cost, status: "provisioning", expiresAt: new Date(Date.now() + data.hours * 3600000), isDemo: IS_DEMO }).returning();
      return { rental, created: true };
    });
    if (!reservation.created) return Response.json({ rental: reservation.rental });
    const pending = reservation.rental;
    try {
      let providerId: string; let phone: string; let expiresAt = pending.expiresAt;
      if (IS_DEMO) { providerId = `demo_${pending.id}`; phone = `+1 202 555 01${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`; }
      else {
        const result = record(unwrap(await providerRequest("/rentals", { method: "POST", body: { service: data.service, country: data.country, duration: data.hours }, idempotencyKey: pending.orderId })));
        providerId = String(result.id ?? result.rental_id ?? ""); phone = String(result.phoneNumber ?? result.phone_number ?? result.phone ?? result.number ?? "");
        if (!providerId || !phone) throw new ProviderError("The provider response needs manual reconciliation. Your rental is saved; please do not rent again.", 502, true);
        const expiry = new Date(String(result.expiresAt ?? result.expires_at ?? "")); if (Number.isFinite(expiry.getTime())) expiresAt = expiry;
      }
      const [rental] = await db.update(rentals).set({ providerId, phone, expiresAt, status: "active" }).where(eq(rentals.id, pending.id)).returning();
      await db.update(orders).set({ status: "completed" }).where(eq(orders.id, pending.orderId));
      await audit(user.id, "rental.reserved", pending.id, { demo: IS_DEMO, amount, currency: user.currency, hours: data.hours });
      return Response.json({ rental });
    } catch (error) {
      if (error instanceof ProviderError && error.uncertain) {
        const [rental] = await db.update(rentals).set({ status: "reconciliation" }).where(eq(rentals.id, pending.id)).returning();
        await db.update(orders).set({ status: "reconciliation" }).where(eq(orders.id, pending.orderId));
        return Response.json({ rental, warning: error.message });
      }
      await refundOrder(pending.orderId, "Rental could not be provisioned");
      throw error;
    }
  } catch (e) { return apiError(e); }
}
