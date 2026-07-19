import { Pool } from 'pg';
import { MigrationManager, MigrationDirection } from './migration-manager';

async function main(): Promise<void> {
  const direction = (process.env.MIGRATION_DIRECTION ?? process.argv[2] ?? 'up') as MigrationDirection | 'status' | 'plan';
  const targetVersion = process.env.MIGRATION_TARGET_VERSION ?? process.argv[3];
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const manager = new MigrationManager(pool);

  try {
    if (direction === 'status') {
      console.log(JSON.stringify(await manager.status(), null, 2));
      return;
    }
    if (direction === 'plan') {
      const planDirection = (process.env.MIGRATION_PLAN_DIRECTION ?? 'up') as MigrationDirection;
      console.log(JSON.stringify(await manager.plan(planDirection, targetVersion), null, 2));
      return;
    }
    const result = direction === 'down' ? await manager.down(targetVersion) : await manager.up(targetVersion);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main };
