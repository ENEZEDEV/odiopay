import { randomUUID, randomBytes } from 'node:crypto';
import { transaction } from './database.js';
import { digest } from './security.js';
import { exactObject, idempotencyKey, isId, MAX_AMOUNT } from './validation.js';
import { requireThat } from './errors.js';

// Internal persistence primitive. No HTTP exposure, provider calls or balance credits.
// commissionCents comes from trusted server pricing, never the checkout request.
export class MercadoPagoIntents {
  constructor(db, { now = Date.now } = {}) { this.db = db; this.now = now; }
  create(merchantId, environment, key, input, commissionCents) {
    requireThat(isId(merchantId), 401, 'mp_identity_required');
    requireThat(['test', 'production'].includes(environment), 400, 'mp_invalid_environment');
    idempotencyKey(key);
    exactObject(input, ['amountCents', 'method', 'payerEmail', 'cardToken', 'paymentMethodId'], ['amountCents', 'method', 'payerEmail']);
    requireThat(Number.isSafeInteger(input.amountCents) && input.amountCents >= 100 && input.amountCents <= MAX_AMOUNT, 400, 'invalid_amount');
    requireThat(['pix', 'card'].includes(input.method), 400, 'invalid_method');
    requireThat(typeof input.payerEmail === 'string' && input.payerEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.payerEmail), 400, 'invalid_payer');
    if (input.method === 'card') {
      requireThat(typeof input.cardToken === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(input.cardToken) && !/^\d{12,19}$/.test(input.cardToken), 400, 'invalid_card_token');
      requireThat(typeof input.paymentMethodId === 'string' && /^[a-z][a-z0-9_]{1,30}$/.test(input.paymentMethodId) && !['pix', 'boleto', 'account_money'].includes(input.paymentMethodId), 400, 'invalid_method');
    } else requireThat(!Object.hasOwn(input, 'cardToken') && !Object.hasOwn(input, 'paymentMethodId'), 400, 'unexpected_card_data');
    const fingerprint = digest(JSON.stringify([input.amountCents, input.method, input.payerEmail, input.cardToken ?? null, input.paymentMethodId ?? null]));
    return transaction(this.db, () => {
      requireThat(this.db.prepare('SELECT id FROM merchants WHERE id=?').get(merchantId), 401, 'mp_identity_required');
      const existing = this.db.prepare('SELECT * FROM mp_payment_intents WHERE merchant_id=? AND environment=? AND idempotency_key=?').get(merchantId, environment, key);
      if (existing) {
        requireThat(existing.request_digest === fingerprint, 409, 'idempotency_conflict');
        return { intent: existing, replayed: true };
      }
      requireThat(Number.isSafeInteger(commissionCents) && commissionCents >= 0 && commissionCents < input.amountCents, 400, 'invalid_commission');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO mp_payment_intents
        (id,merchant_id,environment,idempotency_key,request_digest,amount_cents,commission_cents,method,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,'created',?)`).run(id, merchantId, environment, key, fingerprint, input.amountCents, commissionCents, input.method, this.now());
      return { intent: this.get(merchantId, id), replayed: false };
    });
  }
  get(merchantId, id) {
    const row = this.db.prepare('SELECT * FROM mp_payment_intents WHERE merchant_id=? AND id=?').get(merchantId, id);
    requireThat(row, 404, 'intent_not_found');
    return row;
  }
  claim(merchantId, id) {
    const token = randomBytes(32).toString('hex');
    const row = this.db.prepare(`UPDATE mp_payment_intents SET status='sending',claim_hash=?,claimed_at=?
      WHERE merchant_id=? AND id=? AND status='created' RETURNING *`).get(digest(token), this.now(), merchantId, id);
    return row ? { intent: row, token } : null;
  }
  markUncertain(merchantId, id, token) {
    requireThat(typeof token === 'string', 409, 'invalid_claim');
    const result = this.db.prepare(`UPDATE mp_payment_intents SET status='requires_reconciliation',claim_hash=NULL
      WHERE merchant_id=? AND id=? AND status='sending' AND claim_hash=?`).run(merchantId, id, digest(token));
    requireThat(result.changes === 1, 409, 'invalid_claim');
  }
  recoverInterrupted(cutoff) {
    requireThat(Number.isSafeInteger(cutoff) && cutoff <= this.now(), 400, 'invalid_cutoff');
    // Never put an uncertain send back into created: remote payment may already exist.
    return this.db.prepare(`UPDATE mp_payment_intents SET status='requires_reconciliation',claim_hash=NULL
      WHERE status='sending' AND claimed_at<=?`).run(cutoff).changes;
  }
}
