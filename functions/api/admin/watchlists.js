// Weekend Watch admin recovery API
// Route: /api/admin/watchlists
//
// Required bindings/secrets:
//   WATCHLIST_DB            D1 binding
//   WATCHLIST_ADMIN_SECRET  encrypted Cloudflare secret
//
// Admin can:
//   GET  -> list watchlists and counts
//   POST -> reset a sync phrase or rename a list
//
// Old sync phrases are never recoverable. Resetting changes the phrase hash
// while preserving the list's permanent list_id and all saved/watched items.

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function normalizePhrase(value = "") {
  return String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function validPhrase(phrase) {
  return phrase.length >= 8 && phrase.length <= 80;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPhrase(phrase) {
  return sha256Hex(normalizePhrase(phrase));
}

async function isAdmin(context) {
  const expected = context.env.WATCHLIST_ADMIN_SECRET || "";
  const provided =
    context.request.headers.get("X-WW-Admin-Secret") || "";

  if (!expected || !provided) return false;

  // Compare fixed-size digests rather than raw secret lengths/content.
  const [expectedHash, providedHash] = await Promise.all([
    sha256Hex(expected),
    sha256Hex(provided),
  ]);

  let diff = 0;

  for (let index = 0; index < expectedHash.length; index++) {
    diff |= expectedHash.charCodeAt(index) ^ providedHash.charCodeAt(index);
  }

  return diff === 0;
}

function sameOriginWrite(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  try {
    return origin === new URL(request.url).origin;
  } catch (_) {
    return false;
  }
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

async function requireAdmin(context) {
  if (!context.env.WATCHLIST_DB) {
    return {
      error: json({ error: "WATCHLIST_DB is not configured." }, 500),
    };
  }

  if (!context.env.WATCHLIST_ADMIN_SECRET) {
    return {
      error: json(
        { error: "WATCHLIST_ADMIN_SECRET is not configured." },
        500
      ),
    };
  }

  if (!(await isAdmin(context))) {
    return {
      error: json({ error: "Unauthorized." }, 401),
    };
  }

  return { db: context.env.WATCHLIST_DB };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "GET, POST, OPTIONS",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestGet(context) {
  const a = await requireAdmin(context);
  if (a.error) return a.error;

  const result = await a.db
    .prepare(`
      SELECT
        w.list_id,
        w.display_name,
        w.created_at,
        w.updated_at,
        COALESCE(SUM(
          CASE
            WHEN i.saved = 1 AND i.watched = 0 THEN 1
            ELSE 0
          END
        ), 0) AS to_watch_count,
        COALESCE(SUM(
          CASE
            WHEN i.saved = 1 AND i.watched = 1 THEN 1
            ELSE 0
          END
        ), 0) AS watched_count
      FROM watchlists w
      LEFT JOIN watchlist_items i
        ON i.list_hash = w.list_hash
      GROUP BY
        w.list_id,
        w.display_name,
        w.created_at,
        w.updated_at
      ORDER BY w.updated_at DESC
      LIMIT 200
    `)
    .all();

  const lists = (result.results || []).map(row => ({
    listId: row.list_id,
    displayName: row.display_name || "Unnamed list",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    toWatchCount: Number(row.to_watch_count || 0),
    watchedCount: Number(row.watched_count || 0),
  }));

  return json({ ok: true, lists });
}

export async function onRequestPost(context) {
  if (!sameOriginWrite(context.request)) {
    return json({ error: "Cross-origin writes are not allowed." }, 403);
  }

  const a = await requireAdmin(context);
  if (a.error) return a.error;

  const body = await parseBody(context.request);

  if (!body || typeof body !== "object") {
    return json({ error: "Invalid JSON." }, 400);
  }

  const action = String(body.action || "");
  const listId = String(body.listId || "").trim();

  if (!listId || listId.length > 80) {
    return json({ error: "Invalid list id." }, 400);
  }

  const existing = await a.db
    .prepare(`
      SELECT list_hash, list_id, display_name
      FROM watchlists
      WHERE list_id = ?
      LIMIT 1
    `)
    .bind(listId)
    .first();

  if (!existing) {
    return json({ error: "Watchlist not found." }, 404);
  }

  const now = Date.now();

  if (action === "resetPhrase") {
    const phrase = normalizePhrase(body.newPhrase || "");

    if (!validPhrase(phrase)) {
      return json(
        { error: "New sync phrase must be between 8 and 80 characters." },
        400
      );
    }

    const newHash = await hashPhrase(phrase);

    const collision = await a.db
      .prepare(`
        SELECT list_id
        FROM watchlists
        WHERE list_hash = ?
        LIMIT 1
      `)
      .bind(newHash)
      .first();

    if (collision && collision.list_id !== listId) {
      return json(
        { error: "That sync phrase is already used by another list." },
        409
      );
    }

    if (newHash === existing.list_hash) {
      return json({
        ok: true,
        message: "That phrase already belongs to this list.",
      });
    }

    // D1 batch executes the statements together. There are no foreign-key
    // constraints between these tables; the shared list_hash is changed in
    // both places while permanent list_id stays unchanged.
    await a.db.batch([
      a.db
        .prepare(`
          UPDATE watchlist_items
          SET list_hash = ?, updated_at = ?
          WHERE list_hash = ?
        `)
        .bind(newHash, now, existing.list_hash),

      a.db
        .prepare(`
          UPDATE watchlists
          SET list_hash = ?, updated_at = ?
          WHERE list_id = ?
        `)
        .bind(newHash, now, listId),
    ]);

    return json({
      ok: true,
      message: "Sync phrase reset.",
    });
  }

  if (action === "rename") {
    const displayName = String(body.displayName || "")
      .trim()
      .slice(0, 80);

    await a.db
      .prepare(`
        UPDATE watchlists
        SET display_name = ?, updated_at = ?
        WHERE list_id = ?
      `)
      .bind(displayName, now, listId)
      .run();

    return json({
      ok: true,
      displayName,
    });
  }

  return json({ error: "Unknown action." }, 400);
}
