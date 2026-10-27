-- Esqueleto mínimo das tabelas/funções que as migrations 088/089 usam,
-- para ensaiar o SQL num banco descartável (nunca no de produção).
CREATE TABLE accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE delivery_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE delivery_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE FUNCTION is_account_member(p_account uuid, p_min text DEFAULT 'viewer') RETURNS boolean
LANGUAGE sql AS $$ SELECT true $$;

-- roles que o Supabase tem e a 088/089 referenciam (já existem no cluster)
