import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Qualquer executor de query: conexão ou transação. */
export type Db = Sql | Tx;

export function conectar(url: string): Sql {
  return postgres(url, {
    max: 10,
    idle_timeout: 30,
    // Supabase pooler em modo transaction não suporta prepared statements
    prepare: !url.includes(':6543'),
    connection: { search_path: 'public, extensions' },
    onnotice: () => {},
  });
}
