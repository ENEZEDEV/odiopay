import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { provisionMerchant } from '../src/security.js';
import { MercadoPagoIntents } from '../src/mp-intents.js';

const input = { amountCents: 10000, method: 'pix', payerEmail: 'payer@example.test' };
function fixture(t) {
  const db = openDatabase(); t.after(() => db.close());
  const merchant = provisionMerchant(db, 'Loja teste');
  return { db, merchant, intents: new MercadoPagoIntents(db) };
}
test('intenção persiste comissão original e compara payload antes de replay', t => {
  const { merchant, intents } = fixture(t); const key = randomUUID();
  const first = intents.create(merchant.id, 'production', key, input, 100);
  const claim = intents.claim(merchant.id, first.intent.id);
  assert.ok(claim);
  assert.throws(() => intents.create(merchant.id, 'production', key, { ...input, amountCents: 20000 }, 100), { code: 'idempotency_conflict' });
  const replay = intents.create(merchant.id, 'production', key, input, 200);
  assert.equal(replay.intent.commission_cents, 100);
  assert.equal(replay.replayed, true);
  assert.equal(intents.claim(merchant.id, first.intent.id), null);
});
test('intenção isola lojistas e ambientes sem permitir leitura cruzada', t => {
  const { db, merchant, intents } = fixture(t); const other = provisionMerchant(db, 'Outra loja'); const key = randomUUID();
  const a = intents.create(merchant.id, 'production', key, input, 100).intent;
  const b = intents.create(other.id, 'production', key, input, 100).intent;
  const c = intents.create(merchant.id, 'test', key, input, 100).intent;
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  assert.throws(() => intents.get(other.id, a.id), { code: 'intent_not_found' });
  assert.equal(intents.claim(other.id, a.id), null);
});
test('resultado incerto não pode ser reenviado; somente titular da reserva pode alterá-la', t => {
  const { merchant, intents } = fixture(t);
  const { intent } = intents.create(merchant.id, 'production', randomUUID(), input, 100);
  const claim = intents.claim(merchant.id, intent.id);
  assert.throws(() => intents.markUncertain(merchant.id, intent.id, 'wrong'), { code: 'invalid_claim' });
  intents.markUncertain(merchant.id, intent.id, claim.token);
  assert.equal(intents.get(merchant.id, intent.id).status, 'requires_reconciliation');
  assert.equal(intents.claim(merchant.id, intent.id), null);
});
test('duas conexões e reinício preservam reserva exclusiva e impedem reenvio', t => {
  const folder = mkdtempSync(join(tmpdir(), 'odiopay-intents-'));
  const path = join(folder, 'db.sqlite'); const db1 = openDatabase(path); const db2 = openDatabase(path);
  t.after(() => { db1.close(); db2.close(); rmSync(folder, { recursive: true }); });
  const merchant = provisionMerchant(db1, 'Loja persistente');
  const a = new MercadoPagoIntents(db1, { now: () => 100 }); const b = new MercadoPagoIntents(db2, { now: () => 200 });
  const { intent } = a.create(merchant.id, 'production', randomUUID(), input, 100);
  assert.ok(a.claim(merchant.id, intent.id)); assert.equal(b.claim(merchant.id, intent.id), null);
  const restarted = new MercadoPagoIntents(db2, { now: () => 300 });
  assert.equal(restarted.recoverInterrupted(200), 1);
  assert.equal(restarted.claim(merchant.id, intent.id), null);
  assert.equal(restarted.get(merchant.id, intent.id).status, 'requires_reconciliation');
});
test('rejeita injeção financeira e não armazena e-mail nem token de cartão', t => {
  const { db, merchant, intents } = fixture(t);
  assert.throws(() => intents.create(merchant.id, 'production', randomUUID(), { ...input, commissionCents: 0 }, 100), { code: 'unexpected_field' });
  const card = { ...input, method: 'card', cardToken: 'opaque_card_token_123456', paymentMethodId: 'visa' };
  const { intent } = intents.create(merchant.id, 'production', randomUUID(), card, 100);
  const serialized = JSON.stringify(db.prepare('SELECT * FROM mp_payment_intents WHERE id=?').get(intent.id));
  assert.ok(!serialized.includes(card.cardToken)); assert.ok(!serialized.includes(input.payerEmail));
});
