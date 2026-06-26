-- expenses: distinguish out-of-pocket (reimbursement) from company-card spend.
alter table public.expenses add column if not exists payment text not null default 'reimbursement'
  check (payment in ('reimbursement','company'));
