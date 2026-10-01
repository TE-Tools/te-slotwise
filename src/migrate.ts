import { loadConfig } from './config.ts';
import { migrate, NodeDb } from './db-node.ts';

const config = loadConfig(process.env);
const db = new NodeDb(config.databasePath);
const applied = await migrate(db);
console.log(applied.length ? `Migrationen angewendet: ${applied.join(', ')}` : 'Datenbank ist aktuell.');
db.close();
