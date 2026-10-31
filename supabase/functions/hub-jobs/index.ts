// Supabase Edge Function hub-jobs: the morning email, the Google Calendar copy, the school feed and the AI planner
// (see handler.ts for the actions and secrets). Its files: index.ts, handler.ts, render.ts, util.ts, google.ts,
// calendar.ts, school.ts, ical.ts, homework.ts.
// Deploy with verify_jwt off (each action checks who is asking):  supabase functions deploy hub-jobs --no-verify-jwt
// supabase/config.toml pins verify_jwt = false for the CLI. Any other deploy (the dashboard, the Supabase
// MCP's deploy_edge_function, whose verify_jwt defaults to true) must turn it off too: with it on, the
// gateway refuses pg_cron's calls (no Authorization header) with 401 and this function never runs.
// The smoke check is this function's own reply to a POST without x-hub-cron: 401 {"error":"Not allowed."};
// the gateway's 401 ("Missing authorization header") means verify_jwt is on.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handle, serviceKey } from './handler.ts';
import type { Deps } from './handler.ts';
import { cutOff } from './homework.ts';

// Supabase's runtime: work that may go on after the answer is sent (the AI planner's call to Claude).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

function publishableKey(): string {
  const keys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS');
  if (keys) {
    try { return JSON.parse(keys).default; } catch { /* fall back to the legacy key */ }
  }
  return Deno.env.get('SUPABASE_ANON_KEY')!;
}

const env = (name: string) => Deno.env.get(name);
const auth = { persistSession: false, autoRefreshToken: false };

const deps: Deps = {
  env,
  fetch,
  // The job functions are service_role only. handle() checks the key exists before asking for this.
  service: () => createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(env)!, { auth }),
  // preview and status ask whoami (and read the logs) as the caller, so row-level security applies.
  user: (authorization: string) => createClient(Deno.env.get('SUPABASE_URL')!, publishableKey(), {
    global: { headers: { Authorization: authorization } },
    auth,
  }),
  // The AI planner answers 202 at once and calls Claude after (homework.ts): the worker lives on until it ends.
  background: (p: Promise<unknown>) => EdgeRuntime.waitUntil(p),
};

Deno.serve((req) => handle(req, deps));

// The worker is being stopped (its time is up): AI runs still open end as 'timeout', best effort. Whatever is
// missed, the run's lease (6 minutes) runs out and the next start closes it.
addEventListener('beforeunload', () => { EdgeRuntime.waitUntil(cutOff(deps)); });
