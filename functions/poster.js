const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMAGE = "https://image.tmdb.org/t/p/w500";

const SUCCESS_TTL = 60 * 60 * 24 * 7; // 7 days
const MISS_TTL = 60 * 15;             // 15 minutes

function normalize(value = "") {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bseason\s*\d+\b/gi, "")
    .replace(/\bs\d+\b/gi, "")
    .replace(/[–—:()[\].,'"]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function searchTitle(value = "") {
  return value
    .replace(/\s*[—–-]\s*season\s*\d+\s*$/i, "")
    .replace(/\s*\(\s*\d{4}\s*\)\s*$/i, "")
    .trim();
}

function yearOf(result, kind) {
  const raw = kind === "tv" ? result.first_air_date : result.release_date;
  return raw ? Number(raw.slice(0, 4)) : null;
}

function chooseBest(results, requestedTitle, requestedYear, kind) {
  const q = normalize(requestedTitle);

  const scored = results
    .filter(result => result.poster_path)
    .map(result => {
      const primary = normalize(kind === "tv" ? result.name : result.title);
      const original = normalize(
        kind === "tv" ? result.original_name : result.original_title
      );
      const resultYear = yearOf(result, kind);

      let score = 0;
      if (primary === q) score += 100;
      if (original === q) score += 95;
      if (primary.includes(q) || q.includes(primary)) score += 20;

      if (kind === "movie" && requestedYear) {
        if (resultYear === requestedYear) score += 35;
        else if (resultYear && Math.abs(resultYear - requestedYear) === 1) score += 5;
        else score -= 15;
      }

      score += Math.min(Number(result.popularity || 0), 50) / 10;
      score += Math.min(Number(result.vote_count || 0), 5000) / 5000;

      return { result, score };
    })
    .sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < 18) return null;
  return scored[0].result;
}

function canonicalCacheKey(requestUrl) {
  const url = new URL(requestUrl);
  url.searchParams.delete("refresh");
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
}

function withCacheHeader(response, value) {
  const copy = new Response(response.body, response);
  copy.headers.set("X-Weekend-Watch-Poster-Cache", value);
  return copy;
}

function cacheInBackground(context, cache, key, response) {
  context.waitUntil(cache.put(key, response.clone()).catch(() => {}));
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);
  const title = (requestUrl.searchParams.get("title") || "").trim();
  const kindRaw = (requestUrl.searchParams.get("kind") || "movie").toLowerCase();
  const yearRaw = requestUrl.searchParams.get("year");
  const forceRefresh = requestUrl.searchParams.get("refresh") === "1";

  if (!title || title.length > 140) {
    return new Response("Missing or invalid title", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  if (!context.env.TMDB_TOKEN) {
    return new Response("TMDB token is not configured", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const kind = ["series", "show", "tv"].includes(kindRaw) ? "tv" : "movie";
  const year = /^\d{4}$/.test(yearRaw || "") ? Number(yearRaw) : null;
  const query = searchTitle(title);

  const cache = caches.default;
  const cacheKey = canonicalCacheKey(requestUrl);

  if (!forceRefresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return withCacheHeader(hit, "HIT");
  }

  const apiUrl = new URL(`${TMDB_API}/search/${kind}`);
  apiUrl.searchParams.set("query", query);
  apiUrl.searchParams.set("include_adult", "false");
  apiUrl.searchParams.set("language", "en-US");

  if (kind === "movie" && year) {
    apiUrl.searchParams.set("primary_release_year", String(year));
  }

  async function search(url) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${context.env.TMDB_TOKEN}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    return response.json();
  }

  let data = await search(apiUrl);
  if (!data) {
    return new Response("TMDB lookup failed", {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let match = chooseBest(data.results || [], query, year, kind);

  if (!match && kind === "movie" && year) {
    apiUrl.searchParams.delete("primary_release_year");
    data = await search(apiUrl);
    if (data) match = chooseBest(data.results || [], query, year, kind);
  }

  if (!match?.poster_path) {
    const miss = new Response("Poster not found", {
      status: 404,
      headers: {
        "Cache-Control": `public, max-age=${MISS_TTL}`,
        "X-Weekend-Watch-Poster-Cache": "MISS-NOT-FOUND",
      },
    });
    cacheInBackground(context, cache, cacheKey, miss);
    return miss;
  }

  // Fetch and return the actual poster. Cloudflare then caches the image
  // response under our /poster?... URL rather than repeating TMDB searches.
  const imageResponse = await fetch(`${TMDB_IMAGE}${match.poster_path}`, {
    headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
  });

  if (!imageResponse.ok) {
    return new Response("Poster image fetch failed", {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const poster = new Response(imageResponse.body, {
    status: 200,
    headers: {
      "Content-Type": imageResponse.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": `public, max-age=${SUCCESS_TTL}, stale-while-revalidate=86400`,
      "X-Content-Type-Options": "nosniff",
      "X-Weekend-Watch-Poster-Cache": forceRefresh ? "REFRESH" : "MISS",
    },
  });

  cacheInBackground(context, cache, cacheKey, poster);
  return poster;
}
