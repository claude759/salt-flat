-- ── Central store registry columns ──────────────────────────────────────────
-- dispensaries becomes the single source of truth every tool joins through:
-- name (DBA/storefront), legal_name, address, license, sales_key (sales-app
-- normalized name), pistil_name (Pistil's store label when it differs), and
-- aliases (workbook/shorthand spellings like "OTC SJ").
alter table public.dispensaries add column if not exists pistil_name text;
alter table public.dispensaries add column if not exists aliases text[] not null default '{}';
create index if not exists dispensaries_pistil_name_idx on public.dispensaries(pistil_name);
