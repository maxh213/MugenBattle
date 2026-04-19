/**
 * Wallet ledger. Every balance change is a wallet_ledger row; user_account.balance_cents
 * is materialised from the ledger sum. Always mutate through credit().
 */

import { getDb } from './db.js';

/**
 * Apply a balance change atomically. Returns the new materialised balance.
 * Positive delta = credit, negative = debit.
 */
export function credit(db, userId, deltaCents, reason, refId = null) {
  if (!Number.isInteger(deltaCents)) throw new Error('deltaCents must be an integer');
  if (!reason) throw new Error('reason required');
  const txn = db.transaction(() => {
    db.prepare(
      'INSERT INTO wallet_ledger (user_id, delta_cents, reason, ref_id) VALUES (?, ?, ?, ?)'
    ).run(userId, deltaCents, reason, refId);
    db.prepare(
      'UPDATE user_account SET balance_cents = balance_cents + ? WHERE id = ?'
    ).run(deltaCents, userId);
    const { balance_cents } = db
      .prepare('SELECT balance_cents FROM user_account WHERE id = ?')
      .get(userId);
    return balance_cents;
  });
  return txn();
}

/** Assert that user_account.balance_cents equals the ledger sum. Debugging / cron. */
export function assertLedgerIntegrity(db) {
  const bad = db.prepare(`
    SELECT u.id, u.username, u.balance_cents AS materialised,
      COALESCE((SELECT SUM(delta_cents) FROM wallet_ledger WHERE user_id = u.id), 0) AS ledger_sum
    FROM user_account u
    WHERE u.balance_cents !=
      COALESCE((SELECT SUM(delta_cents) FROM wallet_ledger WHERE user_id = u.id), 0)
  `).all();
  return bad;
}
