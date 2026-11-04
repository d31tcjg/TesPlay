import { rateLimit } from "express-rate-limit";
import {
  SESSION_COOKIE,
  constantTimeEqual,
  cookieOptions,
  cleanText,
  hashPassword,
  httpError,
  randomToken,
  validateEmail,
  validatePassword,
  verifyPassword,
} from "./security.js";
import {
  validatePlayerPreferences,
  defaultPlayerPreferences,
} from "./player-preferences.js";
import { validateUsername } from "./auth-context.js";
export async function registerAuthRoutes(
  app,
  { store, setupToken, authStatus, startSession },
) {
  const authLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
  });
  const setupLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: "Too many setup attempts. Try again in 15 minutes." },
  });
  app.get("/api/auth/status", (req, res) => res.json(authStatus(req)));
  app.post("/api/auth/setup", setupLimit, async (req, res) => {
    if (!store.setupRequired())
      throw httpError(
        409,
        "This server already has an owner. Sign in instead.",
      );
    if (!constantTimeEqual(req.body?.setupToken, setupToken))
      throw httpError(
        403,
        "Enter the setup token shown in your server terminal.",
      );
    const name = cleanText(req.body.name, "Name", 60);
    const username =
      req.body.username === undefined
        ? undefined
        : validateUsername(req.body.username);
    const email = username ? undefined : validateEmail(req.body.email);
    const password = validatePassword(req.body.password);
    const playbackDefaults =
      req.body.playbackDefaults === undefined
        ? defaultPlayerPreferences
        : validatePlayerPreferences(req.body.playbackDefaults);
    const user = store.createOwner({
      name,
      email,
      username,
      passwordHash: await hashPassword(password),
      playbackDefaults,
    });
    startSession(req, res, user);
    res.status(201).json(authStatus(req));
  });
  // A fixed dummy hash keeps unknown-account and wrong-password work comparable.
  const dummyHash = await hashPassword(randomToken());
  app.post("/api/auth/login", authLimit, async (req, res) => {
    const identity = String(req.body?.username ?? req.body?.email ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 254);
    const user = store.findUser(identity);
    const passwordMatches = await verifyPassword(
      req.body?.password,
      user?.password_hash ?? dummyHash,
    );
    if (!user || user.disabled || !passwordMatches)
      throw httpError(401, "Username or password is incorrect.");
    startSession(req, res, user);
    res.json(authStatus(req));
  });
}

export function registerSessionRoutes(app, { store, remote, publicUrl }) {
  app.get("/api/browsers", (req, res) =>
    res.json({ browsers: store.listBrowsers(req.user.id, req.session.id) }),
  );
  app.delete("/api/browsers/:id", (req, res) => {
    const exists = store
      .listBrowsers(req.user.id, req.session.id)
      .some((b) => b.id === req.params.id);
    if (!exists)
      throw httpError(404, "This browser authorization was not found.");
    remote.closeSession(req.params.id);
    store.deleteBrowser(req.user.id, req.params.id);
    if (req.params.id === req.session.id) {
      const { maxAge, ...clearOptions } = cookieOptions(req, publicUrl);
      res.clearCookie(SESSION_COOKIE, clearOptions);
    }
    res.json({ ok: true, current: req.params.id === req.session.id });
  });
  app.post("/api/auth/logout", (req, res) => {
    store.deleteSession(req.session.id);
    remote.closeSession(req.session.id);
    const { maxAge, ...clearOptions } = cookieOptions(req, publicUrl);
    res.clearCookie(SESSION_COOKIE, clearOptions);
    res.json({ ok: true });
  });
}
