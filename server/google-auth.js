import { randomBytes, createHash } from "node:crypto";
import { providerError } from "./media.js";

export function createGoogleAuth({ fetchData, saveConfig, getConnection }) {
  const oauthStates = new Map();
  const googleRefreshes = new Map();
  const clientConfig=c=>({...c,config:{...c.config,clientId:c.config.clientId || process.env.GOOGLE_CLIENT_ID,clientSecret:c.config.clientSecret || process.env.GOOGLE_CLIENT_SECRET}});
  function tokenConfig(c, tokens) {
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || c.config.refreshToken,
      expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    };
  }
  async function googleToken(req, c) {
    // Read the latest encrypted settings before reusing or refreshing a token.
    // Other requests may already have persisted a rotated refresh token.
    c=clientConfig(getConnection(req, c.id));
    if (c.config.accessToken && Number(c.config.expiresAt) > Date.now() + 60000)
      return c.config.accessToken;
    if (!c.config.refreshToken)
      throw providerError(
        `Authorize ${c.type === "youtube" ? "YouTube" : "Google Drive"} before browsing.`,
      );
    const key = `${c.id}:${createHash("sha256").update(JSON.stringify(c.config)).digest("hex")}`;
    let flight = googleRefreshes.get(key);
    if (!flight) {
      flight = (async () => {
        let tokens;
        try {
          tokens = await fetchData("https://oauth2.googleapis.com/token", {
            method: "POST",
            oauthToken: true,
            signal: AbortSignal.timeout(15000),
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: c.config.clientId,
              client_secret: c.config.clientSecret,
              refresh_token: c.config.refreshToken,
              grant_type: "refresh_token",
            }).toString(),
          });
        } catch (error) {
          if (error?.oauthCode === 'invalid_grant') throw providerError(
            `Google authorization for ${c.type === 'youtube' ? 'YouTube' : 'Drive'} has expired or was revoked. Open Connections and reconnect your Google account.`, 409,
          );
          if (error?.oauthCode === 'invalid_client') throw providerError(
            'Google rejected the OAuth client settings. Check the client ID and secret in Connections, then reconnect Google.', 409,
          );
          throw error;
        }
        if (!tokens.access_token)
          throw providerError(
            "Google could not refresh access. Reconnect this account in settings.",
            502,
          );
        const refreshed = tokenConfig(c, tokens);
        saveConfig(req, c, refreshed);
        return refreshed;
      })();
      googleRefreshes.set(key, flight);
    }
    try {
      const refreshed = await flight;
      Object.assign(c.config, refreshed);
      return refreshed.accessToken;
    } finally {
      if (googleRefreshes.get(key) === flight) googleRefreshes.delete(key);
    }
  }
  function registerRoutes(app, { connection, route }) {
    for (const type of ["drive", "youtube"]) {
      app.get(
        `/api/${type}/auth`,
        route(async (req, res) => {
          const c = clientConfig(connection(req, req.query.connectionId, type));
          if (c.shared) throw providerError('Only the connection owner can authorize this shared connection.', 403);
          if (!c.config.clientId || !c.config.clientSecret)
            throw providerError(
              "Google sign-in is not configured on this server yet.",
            );
          for (const [key, value] of oauthStates)
            if (value.expires < Date.now()) oauthStates.delete(key);
          if (oauthStates.size > 500)
            throw providerError(
              "Too many pending Google sign-ins. Try again shortly.",
              429,
            );
          const base = process.env.PUBLIC_URL;
          if (!base)
            throw providerError(
              `Set PUBLIC_URL to your HTTPS address before connecting ${type === "drive" ? "Google Drive" : "YouTube"}.`,
            );
          const redirectUri = new URL(`/api/${type}/callback`, base).toString();
          const state = randomBytes(32).toString("base64url");
          const verifier = randomBytes(48).toString("base64url");
          oauthStates.set(state, {
            type,
            connectionId: c.id,
            userId: req.user.id,
            sessionId: req.session.id,
            clientId: c.config.clientId,
            verifier,
            redirectUri,
            expires: Date.now() + 10 * 60000,
          });
          const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
          u.search = new URLSearchParams({
            client_id: c.config.clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: `https://www.googleapis.com/auth/${type === "drive" ? "drive.readonly" : "youtube.readonly"}`,
            access_type: "offline",
            prompt: "consent",
            state,
            code_challenge: createHash("sha256")
              .update(verifier)
              .digest("base64url"),
            code_challenge_method: "S256",
          });
          res.redirect(u.toString());
        }),
      );
      app.get(
        `/api/${type}/callback`,
        route(async (req, res) => {
          const state = String(req.query.state || "");
          const pending = oauthStates.get(state);
          if (
            !pending ||
            pending.type !== type ||
            pending.userId !== req.user.id ||
            pending.sessionId !== req.session.id ||
            pending.expires < Date.now()
          )
            throw providerError("Google authorization expired. Start again.");
          // A callback from another browser cannot consume the owner's pending login.
          oauthStates.delete(state);
          if (req.query.error || !req.query.code)
            throw providerError("Google authorization was not completed.");
          const c = clientConfig(connection(req, pending.connectionId, type));
          if (c.shared) throw providerError('Only the connection owner can authorize this shared connection.', 403);
          if (pending.clientId !== c.config.clientId)
            throw providerError(
              "Google client settings changed. Start sign-in again.",
            );
          const tokens = await fetchData(
            "https://oauth2.googleapis.com/token",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: c.config.clientId,
                client_secret: c.config.clientSecret,
                redirect_uri: pending.redirectUri,
                grant_type: "authorization_code",
                code: String(req.query.code),
                code_verifier: pending.verifier,
              }).toString(),
            },
          );
          if (!tokens.access_token)
            throw providerError("Google did not return an access token.", 502);
          const requiredScope = `https://www.googleapis.com/auth/${type === "drive" ? "drive.readonly" : "youtube.readonly"}`;
          if (
            tokens.scope &&
            !tokens.scope.split(/\s+/).includes(requiredScope)
          )
            throw providerError(
              "Google did not grant the requested account access. Reconnect and allow the requested permission.",
              403,
            );
          saveConfig(req, c, {
            ...(type === "youtube" ? { authMode: "oauth" } : {}),
            ...tokenConfig(c, tokens),
          });
          res.redirect(`/?connected=${type}`);
        }),
      );
    }
  }
  return { token: googleToken, registerRoutes };
}
