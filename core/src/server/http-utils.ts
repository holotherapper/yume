export function corsHeaders(req?: Request): Record<string, string> {
  const origin = resolveLocalOrigin(req?.headers.get("Origin"));
  return {
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export function logReq(req: Request, note?: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const u = new URL(req.url);
  console.log(`[${ts}] ${req.method} ${u.pathname}${note ? ` - ${note}` : ""}`);
}

function resolveLocalOrigin(origin: string | null | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const url = new URL(origin);
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.protocol === "http:") {
      return origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
