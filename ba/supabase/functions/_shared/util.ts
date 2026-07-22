// Shared helpers for the BA app edge functions (Deno runtime).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

export const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  return null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// service-role client (bypasses RLS) — use for storage + privileged writes
export function admin() {
  return createClient(SUPABASE_URL, SERVICE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Resolve the caller from their bearer token. Returns {user, profile} only for a
// signed-in user who has an ACTIVE profile; null otherwise (deactivated users and
// tokens without a profile are treated as unauthorized).
export async function caller(req: Request) {
  const authz = req.headers.get("Authorization") ?? "";
  if (!authz.startsWith("Bearer ")) return null;
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authz } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return null;
  const { data: profile } = await admin()
    .from("profiles").select("*").eq("id", data.user.id).single();
  if (!profile || profile.active === false) return null;
  return { user: data.user, profile };
}

// Does `path` belong to this user (first segment == their id), or are they admin?
export function ownsPath(who: { user: { id: string }; profile?: { role?: string } }, path: string) {
  const owner = String(path).split("/")[0];
  return owner === who.user.id || who.profile?.role === "admin";
}

// Download a storage object and return {base64, mime}.
export async function downloadImage(bucket: string, path: string) {
  const { data, error } = await admin().storage.from(bucket).download(path);
  if (error || !data) throw new Error(`download failed: ${error?.message}`);
  const buf = new Uint8Array(await data.arrayBuffer());
  const lower = path.toLowerCase();
  const mime = (data.type === "application/pdf" || lower.endsWith(".pdf"))
    ? "application/pdf"
    : data.type && data.type.startsWith("image/")
    ? data.type
    : (lower.endsWith(".png") ? "image/png" : "image/jpeg");
  return { base64: encodeBase64(buf), mime };
}

// Pull the first {...} JSON object out of a model response, tolerant of prose.
export function parseJsonLoose(text: string): any {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch { /* ignore */ }
  }
  return null;
}

// Call Claude vision with one image + an instruction, return the text content.
export async function claudeVision(
  base64: string,
  mime: string,
  instruction: string,
  maxTokens = 400,
): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const model = Deno.env.get("OCR_MODEL") ?? "claude-sonnet-4-6";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          // PDFs go up as a document block (Claude reads them natively); images as before
          { type: mime === "application/pdf" ? "document" : "image",
            source: { type: "base64", media_type: mime, data: base64 } },
          { type: "text", text: instruction },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`anthropic ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data?.content ?? []).map((c: any) => c?.text ?? "").join("").trim();
}
