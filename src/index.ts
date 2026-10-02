export interface Env {
  SNAPSHOTS: KVNamespace;
  PUSHOVER_USER_KEY: string;
  PUSHOVER_APPLICATION_TOKEN: string;
  PUSHOVER_ERROR_APPLICATION_TOKEN: string;
  SOURCE_URL: string;
  DEFAULT_TIMEZONE: string;
}

interface ProductInfo {
  name: string;
  price: number;
  qtyCode: string;
  availability: string | null;
}

type Catalog = Record<string, ProductInfo>;

interface StoredSnapshot {
  fetchedAt: string;
  products: Catalog;
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; hills-wholesale-watch/1.0; personal price monitor)";

function unescapeJs(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/**
 * The page is old nested-table HTML with no classes/ids, but every product
 * row's "Add to Cart" button carries an inline add2cart('sku^name^price^...')
 * call that gives us structured data directly. Scoping extraction to each
 * <tr>...</tr> chunk (rather than page-wide regexes) keeps the availability
 * text tied to the right product, since the name/contents cells use the same
 * font styling as the availability cell but wrap an <a> link instead of text.
 */
function parseCatalog(html: string): Catalog {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const catalog: Catalog = {};

  for (const row of rows) {
    const cartMatch = row.match(/add2cart\('((?:\\.|[^'\\])*)'\)/i);
    if (!cartMatch) continue;

    const parts = cartMatch[1].split("^");
    const skuPart = parts[0] ?? "";
    const slugMatch = skuPart.match(/^==([^=]+)==(.+)$/);
    const qtyCode = slugMatch?.[1] ?? "";
    const slug = slugMatch?.[2] ?? skuPart;
    const name = unescapeJs(parts[1] ?? "").trim();
    const price = Number(parts[2]);

    const availMatch = row.match(
      /<font color="black" face="Arial, Helvetica" size="2">([^<]+)<\/font>/i,
    );
    const availability = availMatch ? availMatch[1].trim() : null;

    if (!slug || !Number.isFinite(price)) continue;
    catalog[slug] = { name, price, qtyCode, availability };
  }

  return catalog;
}

interface Diff {
  added: Array<{ slug: string; info: ProductInfo }>;
  removed: Array<{ slug: string; info: ProductInfo }>;
  priceChanges: Array<{ slug: string; name: string; from: number; to: number }>;
}

/**
 * Only tracks additions, removals, and price changes — availability and qty
 * code fluctuate constantly and aren't worth a notification.
 */
function diffCatalogs(previous: Catalog, current: Catalog): Diff {
  const diff: Diff = { added: [], removed: [], priceChanges: [] };

  for (const [slug, info] of Object.entries(current)) {
    const prior = previous[slug];
    if (!prior) {
      diff.added.push({ slug, info });
      continue;
    }
    if (prior.price !== info.price) {
      diff.priceChanges.push({ slug, name: info.name, from: prior.price, to: info.price });
    }
  }

  for (const [slug, info] of Object.entries(previous)) {
    if (!current[slug]) diff.removed.push({ slug, info });
  }

  return diff;
}

function isDiffEmpty(diff: Diff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.priceChanges.length === 0;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatTimestamp(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(iso));
}

function formatDiff(diff: Diff): string {
  const sections: string[] = [];

  if (diff.added.length > 0) {
    const lines = diff.added.map((a) => `• ${a.info.name} — ${money(a.info.price)}`);
    sections.push(`🆕 NEW (${diff.added.length})\n${lines.join("\n")}`);
  }

  if (diff.priceChanges.length > 0) {
    const lines = diff.priceChanges.map((c) => {
      const arrow = c.to > c.from ? "↑" : "↓";
      const delta = money(Math.abs(c.to - c.from));
      return `• ${c.name}\n   ${money(c.from)} → ${money(c.to)}  (${arrow} ${delta})`;
    });
    sections.push(`💰 PRICE CHANGES (${diff.priceChanges.length})\n${lines.join("\n")}`);
  }

  if (diff.removed.length > 0) {
    const lines = diff.removed.map((r) => `• ${r.info.name}`);
    sections.push(`❌ REMOVED (${diff.removed.length})\n${lines.join("\n")}`);
  }

  // Pushover caps messages at 1024 characters, suffix included.
  const MAX_CHARS = 1024;
  let body = sections.join("\n\n");
  if (body.length > MAX_CHARS) {
    const totalChanges = diff.added.length + diff.priceChanges.length + diff.removed.length;
    const suffix = `\n… (${totalChanges} changes total, truncated)`;
    body = body.slice(0, MAX_CHARS - suffix.length) + suffix;
  }
  return body;
}

async function sendPushover(
  env: Env,
  token: string,
  title: string,
  body: string,
): Promise<void> {
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      user: env.PUSHOVER_USER_KEY,
      title,
      message: body,
    }),
  });
  if (!res.ok) {
    console.log(`Pushover failed: ${res.status} ${await res.text()}`);
  }
}

function notify(env: Env, title: string, body: string): Promise<void> {
  return sendPushover(env, env.PUSHOVER_APPLICATION_TOKEN, title, body);
}

// Errors go through a separate Pushover application so they can be given
// their own sound/priority and don't get mixed in with change alerts.
function notifyError(env: Env, title: string, body: string): Promise<void> {
  return sendPushover(env, env.PUSHOVER_ERROR_APPLICATION_TOKEN, title, body);
}

async function runCheck(env: Env, timeZone: string = env.DEFAULT_TIMEZONE): Promise<string> {
  try {
    return await checkCatalog(env, timeZone);
  } catch (err) {
    const msg = `Check failed: ${err instanceof Error ? err.message : String(err)}`;
    console.log(msg);
    await notifyError(env, "Wholesale watch error", msg);
    return msg;
  }
}

async function checkCatalog(env: Env, timeZone: string): Promise<string> {
  const res = await fetch(env.SOURCE_URL, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    const msg = `Fetch failed: ${res.status} ${res.statusText}`;
    console.log(msg);
    await notifyError(env, "Wholesale watch error", msg);
    return msg;
  }
  const html = await res.text();
  const current = parseCatalog(html);
  const count = Object.keys(current).length;

  if (count === 0) {
    const msg = "Parsed 0 products — page structure may have changed.";
    console.log(msg);
    await notifyError(env, "Wholesale watch error", msg);
    return msg;
  }

  const stored = await env.SNAPSHOTS.get<StoredSnapshot>("latest", "json");
  const now = new Date().toISOString();

  if (!stored) {
    await env.SNAPSHOTS.put("latest", JSON.stringify({ fetchedAt: now, products: current }));
    await notify(
      env,
      "Wholesale watch started",
      `Tracking ${count} products on ${env.SOURCE_URL}`,
    );
    return `Baseline stored: ${count} products.`;
  }

  const diff = diffCatalogs(stored.products, current);
  await env.SNAPSHOTS.put("latest", JSON.stringify({ fetchedAt: now, products: current }));

  if (isDiffEmpty(diff)) {
    return `No changes. ${count} products checked at ${formatTimestamp(now, timeZone)}.`;
  }

  const changeCount = diff.added.length + diff.removed.length + diff.priceChanges.length;

  await notify(
    env,
    `Wholesale Pokemon: ${changeCount} change${changeCount === 1 ? "" : "s"}`,
    formatDiff(diff),
  );

  return `${changeCount} changes found and notified at ${formatTimestamp(now, timeZone)}.`;
}

const WORKING_HOURS_START = 8; // 8am
const WORKING_HOURS_END = 18; // 6pm, inclusive

/**
 * The cron trigger fires hourly across a fixed UTC window wide enough to
 * cover both EST and EDT (Cloudflare crons don't observe DST), so the
 * scheduled handler re-checks the actual local hour and no-ops outside
 * working hours. That keeps 8am-6pm correct in Eastern time year-round
 * without a biannual cron edit.
 */
function isWithinWorkingHours(date: Date, timeZone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).format(date),
  );
  return hour >= WORKING_HOURS_START && hour <= WORKING_HOURS_END;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!isWithinWorkingHours(new Date(), env.DEFAULT_TIMEZONE)) return;
    ctx.waitUntil(runCheck(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Cloudflare geolocates the request and hands back the visitor's IANA
    // timezone on request.cf — fall back to the configured default (used for
    // the cron-triggered path, which has no request at all) if that's absent.
    const timeZone = (request.cf?.timezone as string | undefined) ?? env.DEFAULT_TIMEZONE;

    if (url.pathname === "/run") {
      const summary = await runCheck(env, timeZone);
      return new Response(summary, { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/test") {
      await notify(env, "Wholesale watch test", "Test notification (main app).");
      await notifyError(env, "Wholesale watch test", "Test notification (error app).");
      return new Response("Sent test notifications via both Pushover apps.", {
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname === "/") {
      const stored = await env.SNAPSHOTS.get<StoredSnapshot>("latest", "json");
      const body = stored
        ? `Last checked: ${formatTimestamp(stored.fetchedAt, timeZone)}\nProducts tracked: ${Object.keys(stored.products).length}`
        : "No snapshot yet — hit /run to take the first one.";
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
