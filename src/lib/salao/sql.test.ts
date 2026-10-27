// Roda as migrations do módulo Salão (088/089) num Postgres de verdade
// em memória (PGlite) e executa supabase/tests/salao-functions.sql: as
// funções atômicas (rodada, cancelar item, juntar mesa, fechar comanda,
// fechar caixa), a regra "uma comanda aberta por mesa", a fila de
// impressão por tipo/impressora e as permissões das funções.
//
// O banco de verdade tem muito mais tabelas; supabase/tests/salao-stub.sql
// cria só o esqueleto que essas migrations usam.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('migrations 088/089 do Salão (Postgres em memória)', () => {
  it('aplicam e todas as verificações das funções passam', async () => {
    const db = new PGlite();

    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    for (const file of [
      'supabase/tests/salao-stub.sql',
      'supabase/migrations/050_print_queue.sql',
      'supabase/migrations/060_print_jobs_atomic_claim.sql',
      'supabase/migrations/088_salao_schema.sql',
      'supabase/migrations/089_print_jobs_salao.sql',
    ]) {
      await db.exec(read(file));
    }

    // O arquivo de teste usa psql (\set) e RAISE NOTICE; aqui os "ok"
    // viram linhas de uma tabela para o vitest conferir.
    const test = read('supabase/tests/salao-functions.sql')
      .replace('\\set ON_ERROR_STOP on', 'CREATE TABLE t_log (n serial, msg text);')
      .replace("RAISE NOTICE 'ok  - %', label;", "INSERT INTO t_log(msg) VALUES ('ok  - ' || label);")
      .replace("RAISE NOTICE 'ok  - % (erro: %)', label, got;", "INSERT INTO t_log(msg) VALUES ('ok  - ' || label);")
      .replace("RAISE NOTICE 'TUDO CERTO';", "INSERT INTO t_log(msg) VALUES ('TUDO CERTO');");

    let failure: string | null = null;
    try {
      await db.exec(test);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    const { rows } = await db.query<{ msg: string }>('SELECT msg FROM t_log ORDER BY n');
    expect(failure).toBeNull();
    expect(rows.at(-1)?.msg).toBe('TUDO CERTO');
    // Sanidade: o arquivo de teste de fato rodou dezenas de verificações.
    expect(rows.length).toBeGreaterThan(50);
    await db.close();
  }, 60_000);
});
