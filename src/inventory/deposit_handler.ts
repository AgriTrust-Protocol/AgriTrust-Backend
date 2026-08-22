import { Pool } from 'pg';
import { acquireSiloBinLock, releaseSiloBinLock } from './silo_lock';

interface DepositTicket {
  siloId: number;
  binId: number;
  weightKg: number;
  ticketId: string;
  timestamp: Date;
}

interface DepositResult {
  ticketId: string;
  previousBalance: number;
  newBalance: number;
  success: boolean;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function processDeposit(deposit: DepositTicket): Promise<DepositResult> {
  const acquired = await acquireSiloBinLock(deposit.siloId, deposit.binId);
  if (!acquired) {
    throw new Error(
      `Lock acquisition timed out for silo=${deposit.siloId} bin=${deposit.binId} ticket=${deposit.ticketId}`,
    );
  }

  try {
    const { rows: balanceRows } = await pool.query(
      `SELECT balance FROM silo_bins WHERE silo_id = $1 AND bin_id = $2 FOR UPDATE`,
      [deposit.siloId, deposit.binId],
    );

    let previousBalance = 0;
    if (balanceRows.length === 0) {
      await pool.query(`INSERT INTO silo_bins (silo_id, bin_id, balance) VALUES ($1, $2, $3)`, [
        deposit.siloId,
        deposit.binId,
        deposit.weightKg,
      ]);
    } else {
      previousBalance = parseFloat(balanceRows[0].balance);
      const newBalance = previousBalance + deposit.weightKg;

      await pool.query(
        `UPDATE silo_bins SET balance = $3, updated_at = NOW() WHERE silo_id = $1 AND bin_id = $2`,
        [deposit.siloId, deposit.binId, newBalance],
      );
    }

    const { rows: updatedRows } = await pool.query(
      `SELECT balance FROM silo_bins WHERE silo_id = $1 AND bin_id = $2`,
      [deposit.siloId, deposit.binId],
    );

    const newBalance = parseFloat(updatedRows[0].balance);

    await pool.query(
      `INSERT INTO deposit_log (ticket_id, silo_id, bin_id, weight_kg, previous_balance, new_balance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        deposit.ticketId,
        deposit.siloId,
        deposit.binId,
        deposit.weightKg,
        previousBalance,
        newBalance,
      ],
    );

    return {
      ticketId: deposit.ticketId,
      previousBalance,
      newBalance,
      success: true,
    };
  } finally {
    await releaseSiloBinLock(deposit.siloId, deposit.binId);
  }
}
