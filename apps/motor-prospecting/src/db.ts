import postgres from 'postgres';

export type Sql = postgres.Sql;

export function conectar(url: string): Sql {
  return postgres(url, {
    max: 10,
    idle_timeout: 30,
    prepare: !url.includes(':6543'),
    connection: { search_path: 'public, extensions' },
    onnotice: () => {},
  });
}
