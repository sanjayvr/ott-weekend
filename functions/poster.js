// Cloudflare Pages Function: /poster
// Uses the encrypted TMDB_TOKEN secret stored in Cloudflare.
//
// Example:
//   /poster?title=Mayday&kind=movie&year=2026
//   /poster?title=The%20Gentlemen%20%E2%80%94%20Season%202&kind=series
//
// On success this redirects the browser to TMDB's public image CDN.
// If no trustworthy poster is found it returns 404.

const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_IMAGE = "https://image.tmdb.org/t/p/w500";

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
  const raw =
    kind === "tv"
      ? result.first_air_date
      : result.release_date;

  return raw ? Number(raw.slice(0, 4)) : null;
}

function chooseBest(results, requestedTitle, requestedYear, kind) {
  const q = normalize(requestedTitle);

  const scored = results
    .filter((r) => r.poster_path)
    .map((r) => {
      const primary = normalize(
        kind === "tv" ? r.name : r.title
      );

      const original = normalize(
        kind === "tv"
          ? r.original_name
          : r.original_title
      );

      const resultYear = yearOf(r, kind);

      let score = 0;

      if (primary === q) score += 100;
      if (original === q) score += 95;

      if (
        primary.includes(q) ||
        q.includes(primary)
      ) {
        score += 20;
      }

      // Movie release year helps disambiguate results.
      // For series, Season 2 may release in 2026 even though
      // the show itself originally premiered earlier.
      if (kind === "movie" && requestedYear) {
        if (resultYear === requestedYear) {
          score += 35;
        } else if (
          resultYear &&
          Math.abs(resultYear - requestedYear) === 1
        ) {
          score += 5;
        } else {
          score -= 15;
        }
      }

      score +=
        Math.min(Number(r.popularity || 0), 50) / 10;

      score +=
        Math.min(Number(r.vote_count || 0), 5000) /
        5000;

      return {
        result: r,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return null;
  }

  // Avoid obviously unrelated fuzzy matches.
  if (scored[0].score < 18) {
    return null;
  }

  return scored[0].result;
}

export async function onRequestGet(context) {
  const requestUrl = new URL(context.request.url);

  const title = (
    requestUrl.searchParams.get("title") || ""
  ).trim();

  const kindRaw = (
    requestUrl.searchParams.get("kind") || "movie"
  ).toLowerCase();

  const yearRaw =
    requestUrl.searchParams.get("year");

  if (!title || title.length > 140) {
    return new Response(
      "Missing or invalid title",
      {
        status: 400,
      }
    );
  }

  const kind = [
    "series",
    "show",
    "tv",
  ].includes(kindRaw)
    ? "tv"
    : "movie";

  const year = /^\d{4}$/.test(yearRaw || "")
    ? Number(yearRaw)
    : null;

  const query = searchTitle(title);

  if (!context.env.TMDB_TOKEN) {
    return new Response(
      "TMDB token is not configured",
      {
        status: 500,
      }
    );
  }

  const apiUrl = new URL(
    `${TMDB_API}/search/${kind}`
  );

  apiUrl.searchParams.set(
    "query",
    query
  );

  apiUrl.searchParams.set(
    "include_adult",
    "false"
  );

  apiUrl.searchParams.set(
    "language",
    "en-US"
  );

  // Only constrain movies by year.
  if (kind === "movie" && year) {
    apiUrl.searchParams.set(
      "primary_release_year",
      String(year)
    );
  }

  const tmdbResponse = await fetch(
    apiUrl,
    {
      headers: {
        Authorization:
          `Bearer ${context.env.TMDB_TOKEN}`,
        Accept: "application/json",
      },
    }
  );

  if (!tmdbResponse.ok) {
    return new Response(
      "TMDB lookup failed",
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  }

  const data =
    await tmdbResponse.json();

  let match = chooseBest(
    data.results || [],
    query,
    year,
    kind
  );

  // Retry movies without year if the
  // year-constrained search finds nothing.
  if (
    !match &&
    kind === "movie" &&
    year
  ) {
    apiUrl.searchParams.delete(
      "primary_release_year"
    );

    const retry = await fetch(
      apiUrl,
      {
        headers: {
          Authorization:
            `Bearer ${context.env.TMDB_TOKEN}`,
          Accept: "application/json",
        },
      }
    );

    if (retry.ok) {
      const retryData =
        await retry.json();

      match = chooseBest(
        retryData.results || [],
        query,
        year,
        kind
      );
    }
  }

  if (!match?.poster_path) {
    return new Response(
      "Poster not found",
      {
        status: 404,
        headers: {
          "Cache-Control":
            "public, max-age=900",
        },
      }
    );
  }

  const imageUrl =
    `${TMDB_IMAGE}${match.poster_path}`;

  return Response.redirect(
    imageUrl,
    302
  );
}
