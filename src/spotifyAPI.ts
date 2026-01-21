import { createHash } from "crypto";
import { RequestUrlParam, requestUrl } from "obsidian";

export const authEndpoint = "https://accounts.spotify.com/authorize";
export const clientId = "6fac5b281afe437b94080bc41b71c5a7";
export const scopes = ["user-read-currently-playing"];
export const redirectUri = "obsidian://music-vault-callback";

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  refresh_token: string;
}

// PKCE Flow functions
const generateRandomString = (length: number) => {
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], "");
};

const sha256 = (plain: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return createHash("SHA256").update(data).digest();
};

const base64encode = (input: Buffer) => {
  return btoa(String.fromCharCode(...new Uint8Array(input)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
};

const generateCodeChallenge = () => {
  const codeVerifier = generateRandomString(64);
  const hashed = sha256(codeVerifier);
  const codeChallenge = base64encode(hashed);
  return { verifier: codeVerifier, challenge: codeChallenge };
};

export const buildAuthUrlAndVerifier = () => {
  const { verifier, challenge } = generateCodeChallenge();
  const authUrl = new URL(authEndpoint);
  const params = {
    response_type: "code",
    client_id: clientId,
    scope: scopes.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    redirect_uri: redirectUri,
  };
  authUrl.search = new URLSearchParams(params).toString();
  return [authUrl.toString(), verifier];
};

/* mimic https://developer.mozilla.org/en-US/docs/Web/API/Response/ok */
const ok = (status: number) => {
  return status >= 200 && status <= 299;
};

export const fetchToken = async (
  code: string,
  verifier: string,
  redirectUri: string
): Promise<TokenResponse | undefined> => {
  const params: RequestUrlParam = {
    url: "https://accounts.spotify.com/api/token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  };

  const res = await requestUrl(params);

  if (ok(res.status)) {
    return res.json;
  }
  return undefined;
};

export const refreshToken = async (
  refreshToken: string
): Promise<TokenResponse | undefined> => {
  const params: RequestUrlParam = {
    url: "https://accounts.spotify.com/api/token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  };
  const res = await requestUrl(params);

  if (ok(res.status)) {
    return res.json;
  }
  return undefined;
};

/** Return type for a song fetched from Spotify */
export type Song = {
  id: string;                 // track id
  name: string;
  link: string;

  isrc?: string;              // from external_ids.isrc
  duration_ms?: number;
  explicit?: boolean;
  popularity?: number;

  artists?: {
    id: string;               // artist id
    name: string;
    link?: string;
  }[];

  album?: {
    name: string;
    release_date?: string;
  };

  genres?: string[];          // Combined deduplicated genres from all artists
};

/*export type AudioFeatures = {
  danceability: number;
  energy: number;
  loudness: number; // dB
  speechiness: number;
  acousticness: number;
  instrumentalness: number;
  liveness: number;
  valence: number;
  tempo: number; // BPM
};

export const fetchAudioFeatures = async (
  token: string,
  trackId: string
): Promise<AudioFeatures | undefined> => {
  const res = await requestUrl({
    url: `https://api.spotify.com/v1/audio-features/${trackId}`,
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!ok(res.status)) return undefined;

  const af = res.json as AudioFeatures;
  return af;
};*/

/**
 * Fetch the current playing song from spotify. Undefined if nothing playing or an error occurred.
 * `token` is expected to be a valid, non-expired, access token.
 */
const parseSongFromTrack = (item: any): Song | undefined => {
  if (!item) return undefined;
  return {
    id: item.id ?? "",
    name: item.name ?? "",
    link: item.external_urls?.spotify ?? item.uri ?? "",
    isrc: item.external_ids?.isrc,
    duration_ms: item.duration_ms,
    explicit: item.explicit,
    popularity: item.popularity,
    artists: (item.artists ?? []).map((a: any) => ({
      id: a.id ?? "",
      name: a.name ?? "",
      link: a.external_urls?.spotify,
    })),
    album: item.album
      ? { name: item.album.name, release_date: item.album.release_date }
      : undefined,
  };
};

export const fetchCurrentSong = async (
  token: string
): Promise<Song | undefined> => {
  const params: RequestUrlParam = {
    url: "https://api.spotify.com/v1/me/player/currently-playing",
    headers: { Authorization: `Bearer ${token}` },
  };
  const res = await requestUrl(params);

  if (ok(res.status)) {
    try {
      const obj = res.json;
      if (!obj?.is_playing) return undefined;
      const item = obj.item;
      if (!item || item.type !== "track") return undefined;
      return parseSongFromTrack(item);
    } catch (e: unknown) {
      console.error("Failed to parse response json in fetchCurrentSong: ", e);
      return undefined;
    }
  }
  return undefined;
};

export const fetchSongById = async (
  token: string,
  trackId: string
): Promise<Song | undefined> => {
  const params: RequestUrlParam = {
    url: `https://api.spotify.com/v1/tracks/${trackId}`,
    headers: { Authorization: `Bearer ${token}` },
  };
  const res = await requestUrl(params);

  if (ok(res.status)) {
    try {
      return parseSongFromTrack(res.json);
    } catch (e: unknown) {
      console.error("Failed to parse response json in fetchSongById: ", e);
      return undefined;
    }
  }
  return undefined;
};

export interface SpotifyProfile {
  display_name: string;
  external_urls: Record<string, string>;
  images: [{ height: number; width: number; url: string }];
  // There is more we don't care about
  // TODO: Use the spotify types from npm?
}

/**
 * Fetch a user's profile corresponding with accessToken from spotify.
 * @param accessToken is expected to be a valid, non-expired, access token
 * @returns Promise to a profile or undefined if an error occurred
 */
export const fetchProfile = async (
  accessToken: string
): Promise<SpotifyProfile | undefined> => {
  const params = {
    url: "https://api.spotify.com/v1/me",
    headers: {
      Authorization: "Bearer " + accessToken,
    },
  };
  const res = await requestUrl(params);

  if (ok(res.status)) {
    return res.json;
  }
  return undefined;
};

/**
 * Fetch genres for multiple artists from Spotify.
 * Batches up to 50 artist IDs per request (Spotify API limit).
 * @returns Map of artistId -> genres[]
 */
export const fetchArtistGenres = async (
  token: string,
  artistIds: string[]
): Promise<Map<string, string[]>> => {
  const result = new Map<string, string[]>();
  if (!artistIds.length) return result;

  // Deduplicate and filter empty IDs
  const uniqueIds = [...new Set(artistIds.filter(Boolean))];

  // Batch into chunks of 50 (Spotify API limit)
  const batchSize = 50;
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const params: RequestUrlParam = {
      url: `https://api.spotify.com/v1/artists?ids=${batch.join(",")}`,
      headers: { Authorization: `Bearer ${token}` },
    };

    try {
      const res = await requestUrl(params);
      if (ok(res.status) && res.json?.artists) {
        for (const artist of res.json.artists) {
          if (artist?.id && Array.isArray(artist.genres)) {
            result.set(artist.id, artist.genres);
          }
        }
      }
    } catch (e) {
      console.error("Error fetching artist genres:", e);
    }
  }

  return result;
};
