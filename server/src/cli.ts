// Account management from the shell. Usage:
//   npm run account -- create --name claude --kind agent --system claude
//   npm run account -- create --name ivan --kind human --role admin
//   npm run account -- list
//   npm run account -- rotate --name claude
import { parseArgs } from 'node:util';
import { migrate, pool, q1 } from './db.ts';
import { CreateAccount } from './schemas.ts';
import { createAccount, listAccounts, rotateKey } from './service.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    kind: { type: 'string' },
    system: { type: 'string' },
    role: { type: 'string' },
  },
});

function printKey(name: string, key: string): void {
  console.log(`\nAccount: ${name}\nAPI key: ${key}\n\nThe key is shown once - store it now.`);
}

try {
  await migrate();
  switch (positionals[0]) {
    case 'create': {
      const input = CreateAccount.parse(values);
      const { account, key } = await createAccount(input);
      printKey(account.name, key);
      break;
    }
    case 'rotate': {
      const row = await q1('select id, name, kind, system, role from accounts where name = $1', [
        values.name,
      ]);
      if (!row) throw new Error(`account "${values.name}" not found`);
      const { account, key } = await rotateKey({ ...row, role: 'admin' } as any, row.id);
      printKey(account.name, key);
      break;
    }
    case 'list':
      console.table(
        (await listAccounts()).map(({ id, name, kind, system, role, key_prefix, disabled }) => ({
          id,
          name,
          kind,
          system,
          role,
          key: key_prefix + '...',
          disabled,
        })),
      );
      break;
    default:
      console.log('commands: create | rotate | list');
      process.exitCode = 1;
  }
} catch (err: any) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
