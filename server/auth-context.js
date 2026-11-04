import {
  SESSION_COOKIE,
  cookieOptions,
  httpError,
  randomToken,
} from "./security.js";

export function validateUsername(value) {
  const username = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username))
    throw httpError(
      400,
      "Use a username of 3–40 letters, numbers, dots, underscores or hyphens.",
    );
  return username;
}
export function createAuthContext(store, { publicUrl }) {
  function authStatus(req) {
    return {
      setupRequired: store.setupRequired(),
      user: req.user,
      profiles: req.user
        ? store
            .profiles(req.user.id)
            .filter(
              (profile) =>
                req.session?.scope !== "remote" ||
                profile.id === req.session.profileId,
            )
        : [],
      activeProfileId: req.session?.profileId ?? null,
      scope: req.session?.scope || "full",
      deviceMode: req.session?.deviceMode || "browser",
      remoteRoomId: req.session?.remoteRoomId || null,
    };
  }
  function startSession(req, res, user) {
    if (req.session) store.deleteSession(req.session.id);
    const token = randomToken();
    const current = store.findUserById(user.id);
    if (!current || current.disabled)
      throw httpError(403, "This account is unavailable.");
    req.session = store.createSession(user.id, token, {
      userAgent: req.headers["user-agent"],
    });
    req.user = store.findUserById(user.id);
    res.cookie(SESSION_COOKIE, token, cookieOptions(req, publicUrl));
  }
  function requireAuth(req, res, next) {
    return req.user && req.session
      ? next()
      : next(httpError(401, "Sign in to continue."));
  }
  function requireOwner(req, res, next) {
    return req.session?.scope !== "remote" && req.user?.role === "owner"
      ? next()
      : next(
          httpError(
            403,
            "Only the server owner can manage accounts and connections.",
          ),
        );
  }
  function getProfileId(req) {
    if (!req.session?.profileId)
      throw httpError(409, "Select a profile first.");
    return req.session.profileId;
  }
  return { authStatus, startSession, requireAuth, requireOwner, getProfileId };
}
