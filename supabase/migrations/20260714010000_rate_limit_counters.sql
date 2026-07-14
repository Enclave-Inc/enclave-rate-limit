-- =============================================================================
-- COPY THIS FILE into each consuming repo's supabase/migrations/ directory.
-- This package cannot run migrations against your Supabase project for you —
-- each product API owns its own DB.
--
-- Suggested consumer path:
--   supabase/migrations/YYYYMMDDHHMMSS_rate_limit_counters.sql
-- =============================================================================

create table if not exists public.rate_limit_counters (
  key text primary key,
  window_start timestamptz not null default now(),
  attempt_count integer not null default 0,
  locked_until timestamptz
);

comment on table public.rate_limit_counters is
  'Shared rate-limit state for edge functions (@enclave/rate-limit)';

comment on column public.rate_limit_counters.key is
  'Caller-composed key, e.g. auth:login:email:user@example.com';

create index if not exists rate_limit_counters_window_start_idx
  on public.rate_limit_counters (window_start);

create index if not exists rate_limit_counters_locked_until_idx
  on public.rate_limit_counters (locked_until)
  where locked_until is not null;

-- Atomic check-and-increment with row lock / upsert retry so concurrent
-- edge invocations cannot lose increments (no client read-then-write).
create or replace function public.rate_limit_check_and_increment(
  p_key text,
  p_window_seconds integer,
  p_max_attempts integer,
  p_mode text,
  p_base_delay_seconds integer default 1,
  p_max_delay_seconds integer default 300,
  p_lockout_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_lockout_seconds integer := coalesce(nullif(p_lockout_seconds, 0), p_window_seconds);
  v_row public.rate_limit_counters%rowtype;
  v_attempt integer;
  v_retry integer := 0;
  v_allowed boolean := true;
  v_window_start timestamptz;
  v_new_lock timestamptz;
  v_tries integer := 0;
begin
  if p_key is null or length(trim(p_key)) = 0 then
    raise exception 'rate_limit key must not be empty';
  end if;
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'window_seconds must be > 0';
  end if;
  if p_max_attempts is null or p_max_attempts < 0 then
    raise exception 'max_attempts must be >= 0';
  end if;
  if p_mode not in ('throttle', 'lockout') then
    raise exception 'mode must be throttle or lockout';
  end if;
  if p_base_delay_seconds is null or p_base_delay_seconds < 0 then
    raise exception 'base_delay_seconds must be >= 0';
  end if;
  if p_max_delay_seconds is null or p_max_delay_seconds < 0 then
    raise exception 'max_delay_seconds must be >= 0';
  end if;

  loop
    v_tries := v_tries + 1;
    if v_tries > 5 then
      raise exception 'rate_limit_check_and_increment: contention retries exceeded';
    end if;

    select * into v_row
    from public.rate_limit_counters
    where key = p_key
    for update;

    if found then
      if v_row.locked_until is not null and v_row.locked_until > v_now then
        v_retry := greatest(
          1,
          ceil(extract(epoch from (v_row.locked_until - v_now)))::integer
        );
        return jsonb_build_object(
          'allowed', false,
          'attemptCount', v_row.attempt_count,
          'retryAfterSeconds', v_retry
        );
      end if;

      -- Expired lockout (or no lock): continue. Prefer a fresh window after lock.
      if v_row.locked_until is not null and v_row.locked_until <= v_now then
        v_window_start := v_now;
        v_attempt := 1;
      elsif v_row.window_start > v_now - make_interval(secs => p_window_seconds) then
        v_window_start := v_row.window_start;
        v_attempt := v_row.attempt_count + 1;
      else
        v_window_start := v_now;
        v_attempt := 1;
      end if;

      v_new_lock := null;
      if p_mode = 'lockout' and v_attempt > p_max_attempts then
        v_new_lock := v_now + make_interval(secs => v_lockout_seconds);
      end if;

      update public.rate_limit_counters
      set
        window_start = v_window_start,
        attempt_count = v_attempt,
        locked_until = v_new_lock
      where key = p_key
      returning * into v_row;

      exit;
    else
      v_attempt := 1;
      v_window_start := v_now;
      v_new_lock := null;
      if p_mode = 'lockout' and v_attempt > p_max_attempts then
        v_new_lock := v_now + make_interval(secs => v_lockout_seconds);
      end if;

      begin
        insert into public.rate_limit_counters (key, window_start, attempt_count, locked_until)
        values (p_key, v_window_start, v_attempt, v_new_lock)
        returning * into v_row;
        exit;
      exception
        when unique_violation then
          -- Concurrent inserter won; retry with FOR UPDATE.
          null;
      end;
    end if;
  end loop;

  if p_mode = 'lockout' and v_attempt > p_max_attempts then
    v_allowed := false;
    v_retry := greatest(
      1,
      coalesce(
        ceil(extract(epoch from (v_row.locked_until - v_now)))::integer,
        v_lockout_seconds
      )
    );
  elsif p_mode = 'throttle' then
    v_allowed := true;
    -- retryAfterSeconds = min(maxDelay, base * 2^attemptCount)
    v_retry := least(
      p_max_delay_seconds,
      (p_base_delay_seconds * (2 ^ least(v_attempt, 30)))::integer
    );
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'attemptCount', v_attempt,
    'retryAfterSeconds', case when v_retry > 0 then v_retry else null end
  );
end;
$$;

revoke all on function public.rate_limit_check_and_increment(
  text, integer, integer, text, integer, integer, integer
) from public;
grant execute on function public.rate_limit_check_and_increment(
  text, integer, integer, text, integer, integer, integer
) to service_role;

create or replace function public.rate_limit_reset(p_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_key is null or length(trim(p_key)) = 0 then
    raise exception 'rate_limit key must not be empty';
  end if;
  delete from public.rate_limit_counters where key = p_key;
end;
$$;

revoke all on function public.rate_limit_reset(text) from public;
grant execute on function public.rate_limit_reset(text) to service_role;

create or replace function public.rate_limit_cleanup_expired(
  p_max_age_seconds integer default 86400
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_max_age_seconds is null or p_max_age_seconds <= 0 then
    raise exception 'max_age_seconds must be > 0';
  end if;

  delete from public.rate_limit_counters
  where window_start < clock_timestamp() - make_interval(secs => p_max_age_seconds)
    and (locked_until is null or locked_until < clock_timestamp());

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.rate_limit_cleanup_expired(integer) from public;
grant execute on function public.rate_limit_cleanup_expired(integer) to service_role;

alter table public.rate_limit_counters enable row level security;

drop policy if exists rate_limit_counters_deny_anon on public.rate_limit_counters;
create policy rate_limit_counters_deny_anon
  on public.rate_limit_counters as restrictive for all to anon
  using (false) with check (false);

drop policy if exists rate_limit_counters_deny_authenticated on public.rate_limit_counters;
create policy rate_limit_counters_deny_authenticated
  on public.rate_limit_counters as restrictive for all to authenticated
  using (false) with check (false);

grant select, insert, update, delete on table public.rate_limit_counters to service_role;
