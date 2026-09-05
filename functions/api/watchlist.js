// Weekend Watch cloud watchlist API
// Route: /api/watchlist
// Required Cloudflare D1 binding: WATCHLIST_DB
//
// The sync phrase is the credential. It is normalized and SHA-256 hashed;
// only the hash is stored in D1. This is intentionally lightweight because
// the data is only a movie/series watchlist.

const MAX_ITEMS = 100;
const MAX_ITEM_JSON = 16000;
const MAX_BODY = 180000;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
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

async function hashPhrase(phrase) {
  const bytes = new TextEncoder().encode(normalizePhrase(phrase));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
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

async function auth(context) {
  const db = context.env.WATCHLIST_DB;

  if (!db) {
    return {
      error: json({ error: "WATCHLIST_DB is not configured." }, 500),
    };
  }

  const phrase = context.request.headers.get("X-WW-Sync-Phrase") || "";
  const normalized = normalizePhrase(phrase);

  if (!validPhrase(normalized)) {
    return {
      error: json(
        { error: "Sync phrase must be between 8 and 80 characters." },
        401
      ),
    };
  }

  return {
    db,
    listHash: await hashPhrase(normalized),
  };
}

async function listInfo(db, listHash) {
  return db
    .prepare(`
      SELECT list_hash, display_name, created_at, updated_at
      FROM watchlists
      WHERE list_hash = ?
      LIMIT 1
    `)
    .bind(listHash)
    .first();
}

async function parseBody(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);

  if (contentLength > MAX_BODY) {
    throw new Error("BODY_TOO_LARGE");
  }

  const text = await request.text();

  if (text.length > MAX_BODY) {
    throw new Error("BODY_TOO_LARGE");
  }

  try {
    return JSON.parse(text || "{}");
  } catch (_) {
    throw new Error("INVALID_JSON");
  }
}

function validateRecord(record) {
  if (!record || typeof record !== "object") return null;

  const id = String(record.id || "").trim();

  if (!id || id.length > 140) return null;

  const clean = {
    ...record,
    id,
    watched: Boolean(record.watched),
    watchedAt: record.watched ? (record.watchedAt || null) : null,
  };

  const serialized = JSON.stringify(clean);

  if (serialized.length > MAX_ITEM_JSON) return null;

  return {
    id,
    clean,
    serialized,
  };
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
  const a = await auth(context);
  if (a.error) return a.error;

  const info = await listInfo(a.db, a.listHash);

  if (!info) {
    return json({ error: "Sync phrase not found." }, 404);
  }

  const result = await a.db
    .prepare(`
      SELECT item_json, watched, watched_at, updated_at
      FROM watchlist_items
      WHERE list_hash = ? AND saved = 1
      ORDER BY watched ASC, updated_at DESC
      LIMIT ?
    `)
    .bind(a.listHash, MAX_ITEMS)
    .all();

  const items = [];

  for (const row of result.results || []) {
    if (!row.item_json) continue;

    try {
      const item = JSON.parse(row.item_json);
      item.watched = Boolean(row.watched);
      item.watchedAt = row.watched_at || null;
      items.push(item);
    } catch (_) {
      // Ignore one malformed row rather than breaking the list.
    }
  }

  return json({
    ok: true,
    displayName: info.display_name || "",
    items,
  });
}

export async function onRequestPost(context) {
  if (!sameOriginWrite(context.request)) {
    return json({ error: "Cross-origin writes are not allowed." }, 403);
  }

  const a = await auth(context);
  if (a.error) return a.error;

  let body;

  try {
    body = await parseBody(context.request);
  } catch (error) {
    if (error.message === "BODY_TOO_LARGE") {
      return json({ error: "Request too large." }, 413);
    }

    return json({ error: "Invalid JSON." }, 400);
  }

  const action = String(body.action || "");
  const now = Date.now();
  const existing = await listInfo(a.db, a.listHash);

  if (action === "create") {
    if (existing) {
      return json(
        {
          error:
            "That sync phrase is already in use. Choose another phrase, or connect to it instead.",
        },
        409
      );
    }

    const displayName = String(body.displayName || "")
      .trim()
      .slice(0, 80);

    await a.db
      .prepare(`
        INSERT INTO watchlists
          (list_hash, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `)
      .bind(a.listHash, displayName, now, now)
      .run();

    return json({
      ok: true,
      displayName,
    });
  }

  if (!existing) {
    return json({ error: "Sync phrase not found." }, 404);
  }

  if (action === "rename") {
    const displayName = String(body.displayName || "")
      .trim()
      .slice(0, 80);

    await a.db
      .prepare(`
        UPDATE watchlists
        SET display_name = ?, updated_at = ?
        WHERE list_hash = ?
      `)
      .bind(displayName, now, a.listHash)
      .run();

    return json({
      ok: true,
      displayName,
    });
  }

  if (action === "merge") {
    const incoming = Array.isArray(body.items) ? body.items : [];

    if (incoming.length > MAX_ITEMS) {
      return json(
        { error: `A watchlist can contain at most ${MAX_ITEMS} items.` },
        400
      );
    }

    const statements = [];

    for (const raw of incoming) {
      const record = validateRecord(raw);

      if (!record) {
        return json({ error: "One or more saved items are invalid." }, 400);
      }

      const watched = record.clean.watched ? 1 : 0;
      const watchedAt = watched
        ? Number(record.clean.watchedAt || now)
        : null;

      // When merging an existing device into a list, do not accidentally
      // turn an already-watched cloud item back into unwatched.
      statements.push(
        a.db
          .prepare(`
            INSERT INTO watchlist_items
              (
                list_hash,
                item_id,
                item_json,
                saved,
                watched,
                watched_at,
                updated_at
              )
            VALUES (?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(list_hash, item_id) DO UPDATE SET
              item_json = excluded.item_json,
              saved = 1,
              watched = MAX(watchlist_items.watched, excluded.watched),
              watched_at = CASE
                WHEN watchlist_items.watched = 1
                  THEN watchlist_items.watched_at
                ELSE excluded.watched_at
              END,
              updated_at = excluded.updated_at
          `)
          .bind(
            a.listHash,
            record.id,
            record.serialized,
            watched,
            watchedAt,
            now
          )
      );
    }

    if (statements.length) {
      await a.db.batch(statements);
    }

    await a.db
      .prepare(`
        UPDATE watchlists
        SET updated_at = ?
        WHERE list_hash = ?
      `)
      .bind(now, a.listHash)
      .run();

    return json({ ok: true });
  }

  if (action === "set") {
    const saved = Boolean(body.saved);
    const watched = saved && Boolean(body.watched);
    const id = String(body.id || body.item?.id || "").trim();

    if (!id || id.length > 140) {
      return json({ error: "Invalid item id." }, 400);
    }

    let itemJson = null;
    let watchedAt = null;

    if (saved) {
      const record = validateRecord({
        ...(body.item || {}),
        id,
        watched,
        watchedAt: watched
          ? (body.watchedAt || body.item?.watchedAt || now)
          : null,
      });

      if (!record) {
        return json({ error: "Invalid saved item." }, 400);
      }

      itemJson = record.serialized;
      watchedAt = watched
        ? Number(record.clean.watchedAt || now)
        : null;
    }

    await a.db
      .prepare(`
        INSERT INTO watchlist_items
          (
            list_hash,
            item_id,
            item_json,
            saved,
            watched,
            watched_at,
            updated_at
          )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(list_hash, item_id) DO UPDATE SET
          item_json = excluded.item_json,
          saved = excluded.saved,
          watched = excluded.watched,
          watched_at = excluded.watched_at,
          updated_at = excluded.updated_at
      `)
      .bind(
        a.listHash,
        id,
        itemJson,
        saved ? 1 : 0,
        watched ? 1 : 0,
        watchedAt,
        now
      )
      .run();

    await a.db
      .prepare(`
        UPDATE watchlists
        SET updated_at = ?
        WHERE list_hash = ?
      `)
      .bind(now, a.listHash)
      .run();

    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
}
