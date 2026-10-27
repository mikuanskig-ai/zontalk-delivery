-- Testes das funções do módulo Salão (088/089). Roda num banco descartável.
\set ON_ERROR_STOP on

CREATE FUNCTION t_eq(label text, actual anyelement, expected anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FALHOU [%]: esperado %, veio %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok  - %', label;
END $$;

CREATE FUNCTION t_raises(label text, sql text, expected_msg text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  BEGIN
    EXECUTE sql;
    RAISE EXCEPTION 'FALHOU [%]: não deu erro', label;
  EXCEPTION WHEN OTHERS THEN
    got := SQLERRM;
    IF got LIKE 'FALHOU%' THEN RAISE; END IF;
    IF got NOT LIKE '%' || expected_msg || '%' THEN
      RAISE EXCEPTION 'FALHOU [%]: erro esperado %, veio %', label, expected_msg, got;
    END IF;
    RAISE NOTICE 'ok  - % (erro: %)', label, got;
  END;
END $$;

DO $$
DECLARE
  acc uuid; acc2 uuid; t1 uuid; t2 uuid; t3 uuid; staff uuid; tab1 uuid; tab2 uuid;
  r jsonb; item1 uuid; sess uuid; sess2 uuid; n int; v numeric;
BEGIN
  INSERT INTO accounts (name) VALUES ('Teste') RETURNING id INTO acc;
  INSERT INTO accounts (name) VALUES ('Outra conta') RETURNING id INTO acc2;
  INSERT INTO salao_tables (account_id, number) VALUES (acc, 1) RETURNING id INTO t1;
  INSERT INTO salao_tables (account_id, number) VALUES (acc, 2) RETURNING id INTO t2;
  INSERT INTO salao_tables (account_id, number) VALUES (acc, 3) RETURNING id INTO t3;
  INSERT INTO salao_staff (account_id, name, role, pin_hmac) VALUES (acc, 'Carlos', 'garcom', 'h1') RETURNING id INTO staff;

  -- ---------- mesas e comandas ----------
  PERFORM t_raises('mesa repetida na mesma conta',
    format('INSERT INTO salao_tables (account_id, number) VALUES (%L, 1)', acc), 'duplicate key');
  PERFORM t_eq('mesa 1 de outra conta pode existir', (SELECT count(*) FROM (SELECT 1) x WHERE true), 1::bigint);
  INSERT INTO salao_tables (account_id, number) VALUES (acc2, 1);

  PERFORM t_eq('qr_token com 32 hex', (SELECT qr_token ~ '^[0-9a-f]{32}$' FROM salao_tables WHERE id = t1), true);

  INSERT INTO salao_tabs (account_id, table_id, label, opened_by_name, service_fee_percent)
    VALUES (acc, t1, 'Mesa 1', 'Carlos', 10) RETURNING id INTO tab1;
  PERFORM t_raises('uma comanda aberta por mesa',
    format('INSERT INTO salao_tabs (account_id, table_id, label, opened_by_name) VALUES (%L, %L, %L, %L)', acc, t1, 'Mesa 1', 'Ana'),
    'uq_salao_tabs_one_open_per_table');

  -- ---------- rodadas ----------
  r := salao_add_round(acc, tab1, staff, 'Carlos', jsonb_build_array(
    jsonb_build_object('product_id', null, 'product_name', 'Marmita P', 'unit_price', 28, 'quantity', 2,
                       'addons_snapshot', '[]'::jsonb, 'line_total', 56, 'notes', 'sem cebola'),
    jsonb_build_object('product_name', 'Refri', 'unit_price', 6, 'quantity', 1, 'line_total', 6)));
  PERFORM t_eq('rodada 1 numerada', (r->>'round_number')::int, 1);
  PERFORM t_eq('subtotal após rodada 1', (SELECT subtotal FROM salao_tabs WHERE id = tab1), 62.00::numeric);
  PERFORM t_eq('taxa de serviço 10%', (SELECT service_fee_amount FROM salao_tabs WHERE id = tab1), 6.20::numeric);
  PERFORM t_eq('total com taxa', (SELECT total FROM salao_tabs WHERE id = tab1), 68.20::numeric);

  r := salao_add_round(acc, tab1, staff, 'Carlos', jsonb_build_array(
    jsonb_build_object('product_name', 'Suco', 'unit_price', 9, 'quantity', 2, 'line_total', 18)));
  PERFORM t_eq('rodada 2 numerada', (r->>'round_number')::int, 2);
  PERFORM t_eq('total após rodada 2', (SELECT total FROM salao_tabs WHERE id = tab1), 88.00::numeric);
  PERFORM t_eq('observação vazia vira NULL', (SELECT notes FROM salao_tab_items WHERE product_name = 'Refri'), NULL::text);

  PERFORM t_raises('rodada sem itens', format('SELECT salao_add_round(%L, %L, NULL, %L, %L::jsonb)', acc, tab1, 'x', '[]'), 'no_items');
  PERFORM t_raises('rodada em comanda de outra conta',
    format('SELECT salao_add_round(%L, %L, NULL, %L, %L::jsonb)', acc2, tab1, 'x', '[{"product_name":"a","unit_price":1,"quantity":1,"line_total":1}]'), 'tab_not_found');

  -- conta pedida volta a "aberta" quando pedem mais
  UPDATE salao_tabs SET status = 'bill_requested', bill_requested_at = now() WHERE id = tab1;
  r := salao_add_round(acc, tab1, staff, 'Carlos', jsonb_build_array(
    jsonb_build_object('product_name', 'Café', 'unit_price', 5, 'quantity', 1, 'line_total', 5)));
  PERFORM t_eq('pedir mais reabre a conta pedida', (SELECT status FROM salao_tabs WHERE id = tab1), 'open');
  PERFORM t_eq('total com café', (SELECT total FROM salao_tabs WHERE id = tab1), 93.50::numeric);

  -- ---------- cancelar item ----------
  SELECT id INTO item1 FROM salao_tab_items WHERE product_name = 'Café';
  PERFORM salao_cancel_item(acc, item1, staff, 'Carlos', 'cliente desistiu');
  PERFORM t_eq('total após cancelar item', (SELECT total FROM salao_tabs WHERE id = tab1), 88.00::numeric);
  PERFORM t_raises('cancelar item duas vezes', format('SELECT salao_cancel_item(%L, %L, NULL, %L, %L)', acc, item1, 'x', 'y'), 'item_already_cancelled');
  PERFORM t_raises('cancelar item de outra conta', format('SELECT salao_cancel_item(%L, %L, NULL, %L, %L)', acc2, item1, 'x', 'y'), 'item_not_found');

  -- ---------- desconto ----------
  UPDATE salao_tabs SET discount_amount = 8 WHERE id = tab1;
  PERFORM salao_recalc_tab(tab1);
  PERFORM t_eq('desconto abate do total', (SELECT total FROM salao_tabs WHERE id = tab1), 80.00::numeric);
  UPDATE salao_tabs SET service_fee_enabled = false WHERE id = tab1;
  PERFORM salao_recalc_tab(tab1);
  PERFORM t_eq('sem taxa de serviço (80 - desconto 8)', (SELECT total FROM salao_tabs WHERE id = tab1), 72.00::numeric);
  UPDATE salao_tabs SET discount_amount = 0, service_fee_enabled = true WHERE id = tab1;
  PERFORM salao_recalc_tab(tab1);

  -- ---------- transferir / juntar ----------
  PERFORM t_eq('transferir para mesa livre', (salao_transfer_tab(acc, tab1, t2)->>'merged')::boolean, false);
  PERFORM t_eq('rótulo acompanha a mesa', (SELECT label FROM salao_tabs WHERE id = tab1), 'Mesa 2');
  PERFORM t_raises('transferir para a mesma mesa', format('SELECT salao_transfer_tab(%L, %L, %L)', acc, tab1, t2), 'same_table');
  PERFORM t_raises('transferir para mesa de outra conta',
    format('SELECT salao_transfer_tab(%L, %L, %L)', acc, tab1, (SELECT id FROM salao_tables WHERE account_id = acc2 LIMIT 1)), 'table_not_found');

  INSERT INTO salao_tabs (account_id, table_id, label, opened_by_name, guests, service_fee_percent)
    VALUES (acc, t3, 'Mesa 3', 'Ana', 2, 10) RETURNING id INTO tab2;
  PERFORM salao_add_round(acc, tab2, staff, 'Ana', jsonb_build_array(
    jsonb_build_object('product_name', 'Pizza', 'unit_price', 40, 'quantity', 1, 'line_total', 40)));
  PERFORM t_eq('juntar com mesa ocupada', (salao_transfer_tab(acc, tab1, t3)->>'merged')::boolean, true);
  PERFORM t_eq('origem vira cancelada', (SELECT status FROM salao_tabs WHERE id = tab1), 'cancelled');
  PERFORM t_eq('origem aponta para o destino', (SELECT merged_into_tab_id FROM salao_tabs WHERE id = tab1), tab2);
  PERFORM t_eq('itens passam para o destino', (SELECT count(*) FROM salao_tab_items WHERE tab_id = tab2 AND status = 'active'), 4::bigint);
  PERFORM t_eq('total do destino ((80 + 40) + 10%)', (SELECT total FROM salao_tabs WHERE id = tab2), 132.00::numeric);
  PERFORM t_eq('pessoas somadas', (SELECT guests FROM salao_tabs WHERE id = tab2), 3);
  PERFORM t_eq('mesa 2 ficou livre', (SELECT count(*) FROM salao_tabs WHERE table_id = t2 AND status IN ('open','bill_requested')), 0::bigint);
  PERFORM t_raises('comanda juntada não aceita rodada', format('SELECT salao_add_round(%L, %L, NULL, %L, %L::jsonb)', acc, tab1, 'x', '[{"product_name":"a","unit_price":1,"quantity":1,"line_total":1}]'), 'tab_not_open');

  -- ---------- caixa ----------
  INSERT INTO cash_sessions (account_id, opened_by_name, opening_float) VALUES (acc, 'Marta', 100) RETURNING id INTO sess;
  PERFORM t_raises('só um caixa aberto por conta',
    format('INSERT INTO cash_sessions (account_id, opened_by_name) VALUES (%L, %L)', acc, 'Outra'), 'uq_cash_sessions_one_open');
  INSERT INTO cash_sessions (account_id, opened_by_name) VALUES (acc2, 'Marta');

  -- ---------- fechar comanda ----------
  PERFORM t_raises('pagamento que não bate',
    format('SELECT salao_close_tab(%L, %L, NULL, %L, %L::jsonb, %L)', acc, tab2, 'Marta', '[{"method":"pix","amount":100}]', sess), 'payments_mismatch');
  PERFORM t_eq('comanda continua aberta após erro', (SELECT status FROM salao_tabs WHERE id = tab2), 'open');
  PERFORM t_eq('nenhum pagamento gravado após erro', (SELECT count(*) FROM salao_payments WHERE tab_id = tab2), 0::bigint);

  r := salao_close_tab(acc, tab2, NULL, 'Marta',
    '[{"method":"pix","amount":92},{"method":"cash","amount":40,"tendered":50}]'::jsonb, sess);
  PERFORM t_eq('total fechado', (r->>'total')::numeric, 132.00::numeric);
  PERFORM t_eq('status fechada', (SELECT status FROM salao_tabs WHERE id = tab2), 'closed');
  PERFORM t_eq('quem fechou', (SELECT closed_by_name FROM salao_tabs WHERE id = tab2), 'Marta');
  PERFORM t_eq('2 pagamentos gravados', (SELECT count(*) FROM salao_payments WHERE tab_id = tab2), 2::bigint);
  PERFORM t_eq('troco do dinheiro', (SELECT change_amount FROM salao_payments WHERE tab_id = tab2 AND method = 'cash'), 10.00::numeric);
  PERFORM t_eq('pix sem troco', (SELECT change_amount FROM salao_payments WHERE tab_id = tab2 AND method = 'pix'), 0::numeric);
  PERFORM t_raises('fechar duas vezes', format('SELECT salao_close_tab(%L, %L, NULL, %L, %L::jsonb, %L)', acc, tab2, 'Marta', '[]', sess), 'tab_not_open');
  PERFORM t_raises('forma de pagamento inválida',
    format('INSERT INTO salao_payments (account_id, tab_id, method, amount, received_by_name) VALUES (%L, %L, %L, 1, %L)', acc, tab2, 'cheque', 'x'), 'salao_payments_method_check');
  PERFORM t_eq('mesa 3 ficou livre após fechar', (SELECT count(*) FROM salao_tabs WHERE table_id = t3 AND status IN ('open','bill_requested')), 0::bigint);

  -- mesa pode ser aberta de novo depois de fechada
  INSERT INTO salao_tabs (account_id, table_id, label, opened_by_name) VALUES (acc, t3, 'Mesa 3', 'Ana');

  -- comanda zerada fecha sem pagamento
  INSERT INTO salao_tabs (account_id, table_id, label, opened_by_name) VALUES (acc, t1, 'Mesa 1', 'Ana') RETURNING id INTO tab1;
  r := salao_close_tab(acc, tab1, NULL, 'Marta', '[]'::jsonb, sess);
  PERFORM t_eq('comanda de R$ 0 fecha sem pagamento', (SELECT status FROM salao_tabs WHERE id = tab1), 'closed');

  -- ---------- reabrir ----------
  PERFORM t_raises('não reabre se a mesa foi ocupada de novo',
    format('SELECT salao_reopen_tab(%L, %L)', acc, tab2), 'table_busy');
  UPDATE salao_tabs SET status = 'closed' WHERE table_id = t3 AND status = 'open';
  PERFORM salao_reopen_tab(acc, tab2);
  PERFORM t_eq('reaberta', (SELECT status FROM salao_tabs WHERE id = tab2), 'open');
  PERFORM t_eq('pagamentos apagados ao reabrir', (SELECT count(*) FROM salao_payments WHERE tab_id = tab2), 0::bigint);
  PERFORM t_raises('reabrir comanda que não está fechada', format('SELECT salao_reopen_tab(%L, %L)', acc, tab2), 'tab_not_closed');
  r := salao_close_tab(acc, tab2, NULL, 'Marta',
    '[{"method":"pix","amount":92},{"method":"cash","amount":40,"tendered":50}]'::jsonb, sess);

  -- ---------- movimentos e fechamento do caixa ----------
  INSERT INTO cash_movements (account_id, cash_session_id, kind, amount, by_name) VALUES (acc, sess, 'supply', 20, 'Marta');
  INSERT INTO cash_movements (account_id, cash_session_id, kind, amount, by_name) VALUES (acc, sess, 'withdrawal', 30, 'Marta');
  PERFORM t_raises('movimento de valor zero', format('INSERT INTO cash_movements (account_id, cash_session_id, kind, amount, by_name) VALUES (%L, %L, %L, 0, %L)', acc, sess, 'supply', 'x'), 'cash_movements_amount_check');

  r := salao_close_cash_session(acc, sess, NULL, 'Marta', 128, 'ok');
  -- esperado = 100 (fundo) + 40 (dinheiro recebido; o troco não conta) + 20 - 30 = 130
  PERFORM t_eq('dinheiro esperado', (r->>'expected_cash')::numeric, 130.00::numeric);
  PERFORM t_eq('diferença (faltou 2)', (r->>'difference')::numeric, -2.00::numeric);
  PERFORM t_eq('caixa fechado', (SELECT status FROM cash_sessions WHERE id = sess), 'closed');
  PERFORM t_raises('fechar caixa duas vezes', format('SELECT salao_close_cash_session(%L, %L, NULL, %L, 1, NULL)', acc, sess, 'x'), 'session_not_open');
  PERFORM t_raises('fechar caixa de outra conta', format('SELECT salao_close_cash_session(%L, %L, NULL, %L, 1, NULL)', acc2, sess, 'x'), 'session_not_found');
  PERFORM t_raises('valor contado negativo', format('SELECT salao_close_cash_session(%L, %L, NULL, %L, -1, NULL)', acc, sess, 'x'), 'invalid_counted');

  -- depois do caixa fechado, a comanda paga nele não reabre
  PERFORM t_raises('não reabre comanda de caixa já fechado', format('SELECT salao_reopen_tab(%L, %L)', acc, tab2), 'cash_session_closed');
  -- e um novo caixa pode ser aberto
  INSERT INTO cash_sessions (account_id, opened_by_name) VALUES (acc, 'Marta');

  -- ---------- fila de impressão ----------
  INSERT INTO delivery_orders (id) VALUES (gen_random_uuid());
  INSERT INTO print_jobs (account_id, order_id) SELECT acc, id FROM delivery_orders LIMIT 1;
  INSERT INTO print_jobs (account_id, kind, target, payload) VALUES (acc, 'salao_round', 'cozinha', '{"type":"salao_round"}');
  INSERT INTO print_jobs (account_id, kind, target, payload) VALUES (acc, 'salao_bill', 'caixa', '{"type":"salao_bill"}');
  INSERT INTO print_jobs (account_id, kind, target, payload) VALUES (acc, 'cash_report', 'caixa', '{"type":"cash_report"}');

  PERFORM t_raises('delivery sem pedido é recusado',
    format('INSERT INTO print_jobs (account_id) VALUES (%L)', acc), 'print_jobs_order_required');
  PERFORM t_raises('ticket de salão sem conteúdo é recusado',
    format('INSERT INTO print_jobs (account_id, kind, target) VALUES (%L, %L, %L)', acc, 'salao_round', 'cozinha'), 'print_jobs_payload_required');
  PERFORM t_raises('tipo inválido', format('INSERT INTO print_jobs (account_id, kind, payload) VALUES (%L, %L, %L)', acc, 'x', '{}'), 'print_jobs_kind_check');
  PERFORM t_raises('impressora inválida', format('INSERT INTO print_jobs (account_id, kind, target, payload) VALUES (%L, %L, %L, %L)', acc, 'salao_round', 'bar', '{}'), 'print_jobs_target_check');

  -- agente antigo (só 2 argumentos): só delivery
  SELECT count(*) INTO n FROM claim_print_jobs(acc, 20);
  PERFORM t_eq('chamada antiga só pega delivery', n, 1);
  UPDATE print_jobs SET status = 'pending', claimed_at = NULL;

  SELECT count(*) INTO n FROM claim_print_jobs(acc, 20, 120, ARRAY['delivery_order','salao_round','salao_item_cancel','salao_bill','cash_report'], ARRAY['cozinha']);
  PERFORM t_eq('agente novo da cozinha: pedido + rodada', n, 2);
  UPDATE print_jobs SET status = 'pending', claimed_at = NULL;

  SELECT count(*) INTO n FROM claim_print_jobs(acc, 20, 120, ARRAY['delivery_order','salao_round','salao_item_cancel','salao_bill','cash_report'], ARRAY['caixa']);
  PERFORM t_eq('agente do caixa: conta + relatório', n, 2);
  UPDATE print_jobs SET status = 'pending', claimed_at = NULL;

  SELECT count(*) INTO n FROM claim_print_jobs(acc, 20, 120, ARRAY['delivery_order','salao_round','salao_item_cancel','salao_bill','cash_report'], ARRAY['cozinha','caixa']);
  PERFORM t_eq('agente com as duas impressoras recebe tudo', n, 4);
  SELECT count(*) INTO n FROM claim_print_jobs(acc, 20, 120, ARRAY['delivery_order','salao_round','salao_item_cancel','salao_bill','cash_report'], ARRAY['cozinha','caixa']);
  PERFORM t_eq('já reivindicados não voltam', n, 0);
  PERFORM t_eq('conta alheia não vê os jobs', (SELECT count(*) FROM claim_print_jobs(acc2, 20, 120, ARRAY['delivery_order','salao_round','salao_item_cancel','salao_bill','cash_report'], ARRAY['cozinha','caixa'])), 0::bigint);

  -- ---------- permissões das funções ----------
  PERFORM t_eq('anon não executa salao_close_tab', has_function_privilege('anon', 'salao_close_tab(uuid,uuid,uuid,text,jsonb,uuid)', 'execute'), false);
  PERFORM t_eq('authenticated não executa salao_add_round', has_function_privilege('authenticated', 'salao_add_round(uuid,uuid,uuid,text,jsonb)', 'execute'), false);
  PERFORM t_eq('authenticated não executa claim_print_jobs', has_function_privilege('authenticated', 'claim_print_jobs(uuid,integer,integer,text[],text[])', 'execute'), false);
  PERFORM t_eq('service_role executa salao_close_tab', has_function_privilege('service_role', 'salao_close_tab(uuid,uuid,uuid,text,jsonb,uuid)', 'execute'), true);
  PERFORM t_eq('service_role executa claim_print_jobs', has_function_privilege('service_role', 'claim_print_jobs(uuid,integer,integer,text[],text[])', 'execute'), true);

  RAISE NOTICE 'TUDO CERTO';
END $$;
