import { randomInt } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import {
  constantTimeEqual,
  cookieOptions,
  hashToken,
  httpError,
  randomToken,
} from "./security.js";

export const QR_LIFETIME_MS = 5 * 60_000;
export const QR_COOKIE = "tesplay_qr_browser";

// Challenges deliberately expire on server restart. Only credential hashes are
// retained; the QR approval credential can never be used as a polling credential.
export function createQrChallenges({ now = Date.now, capacity = 1000 } = {}) {
  const challenges = new Map();

  function prune() {
    for (const [id, challenge] of challenges)
      if (challenge.expiresAt <= now()) challenges.delete(id);
  }
  function find(id) {
    prune();
    const challenge = typeof id === "string" ? challenges.get(id) : null;
    if (!challenge)
      throw httpError(410, "This sign-in QR has expired. Create a new one.");
    return challenge;
  }
  function matches(value, expected) {
    return (
      typeof value === "string" &&
      value.length >= 32 &&
      value.length <= 128 &&
      constantTimeEqual(hashToken(value), expected)
    );
  }
  function verifyApproval(id, token) {
    const challenge = find(id);
    if (!matches(token, challenge.approvalHash))
      throw httpError(403, "This sign-in QR is not valid. Scan it again.");
    if (challenge.userId)
      throw httpError(409, "This sign-in request has already been approved.");
    return challenge;
  }
  function verifyBrowser(id, binding) {
    const challenge = find(id);
    if (!matches(binding, challenge.browserHash))
      throw httpError(403, "Open this request on the screen that created it.");
    return challenge;
  }

  return {
    create(binding, previousBinding, { remoteScreen = false } = {}) {
      prune();
      if (typeof previousBinding === "string")
        for (const [id, challenge] of challenges)
          if (matches(previousBinding, challenge.browserHash))
            challenges.delete(id);
      if (challenges.size >= capacity)
        throw httpError(429, "Too many sign-in requests. Try again shortly.");
      const id = randomToken(24);
      const token = randomToken();
      const code = String(randomInt(100000, 1000000));
      const expiresAt = now() + QR_LIFETIME_MS;
      challenges.set(id, {
        browserHash: hashToken(binding),
        approvalHash: hashToken(token),
        code,
        expiresAt,
        userId: null,
        ...(remoteScreen ? { remoteScreen: true, approverSessionId: null } : {}),
      });
      return { id, token, code, expiresAt };
    },
    details(id, token) {
      const { code, expiresAt, remoteScreen } = verifyApproval(id, token);
      return { code, expiresAt, ...(remoteScreen ? { remoteScreen: true } : {}) };
    },
    approve(id, token, userId, sessionId) {
      const challenge = verifyApproval(id, token);
      challenge.userId = userId;
      if(challenge.remoteScreen)challenge.approverSessionId=sessionId;
    },
    poll(id, binding) {
      const challenge = verifyBrowser(id, binding);
      if (!challenge.userId) return { status: "pending" };
      challenges.delete(id);
      return { status: "approved", userId: challenge.userId, ...(challenge.remoteScreen ? {remoteScreen:true,approverSessionId:challenge.approverSessionId} : {}) };
    },
    revokeUser(userId) { for(const [id,challenge] of challenges) if(challenge.userId===userId) challenges.delete(id); },
    cancel(id, binding) {
      verifyBrowser(id, binding);
      challenges.delete(id);
    },
    close() {
      challenges.clear();
    },
  };
}

export function registerQrAuthRoutes(
  app,
  { publicUrl, requireAuth, startSession, authStatus, store, remoteEnabled = true },
) {
  const challenges = createQrChallenges();
  const limit = (limit, windowMs, error) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error },
    });
  const initLimit = limit(
    20,
    15 * 60_000,
    "Too many sign-in QR requests. Try again in 15 minutes.",
  );
  const pollLimit = limit(
    180,
    60_000,
    "Slow down sign-in checks for a moment.",
  );
  const approvalLimit = limit(
    30,
    5 * 60_000,
    "Too many sign-in approvals. Try again in five minutes.",
  );
  function qrCookieOptions(req) {
    return {
      ...cookieOptions(req, publicUrl),
      path: "/api/auth/qr",
      sameSite: "strict",
      maxAge: QR_LIFETIME_MS,
    };
  }
  function clearQrCookie(req, res) {
    const { maxAge, ...options } = qrCookieOptions(req);
    res.clearCookie(QR_COOKIE, options);
  }

  app.post("/api/auth/qr/init", initLimit, (req, res) => {
    const binding = randomToken();
    const { token, ...challenge } = challenges.create(
      binding,
      req.cookies[QR_COOKIE],
      {remoteScreen: remoteEnabled && req.body?.remoteScreen === true},
    );
    res.cookie(QR_COOKIE, binding, qrCookieOptions(req));
    // Mutating API origins have already passed the shared CSRF middleware. In
    // development the browser origin retains Vite's port for the phone page.
    const origin =
      publicUrl || req.get("origin") || `${req.protocol}://${req.get("host")}`;
    const url = new URL("/", origin);
    url.searchParams.set("approve", challenge.id);
    url.hash = new URLSearchParams({ token }).toString();
    res.status(201).json({ ...challenge, verificationUrl: url.href });
  });
  app.post("/api/auth/qr/poll", pollLimit, (req, res) => {
    const result = challenges.poll(req.body?.id, req.cookies[QR_COOKIE]);
    if (result.status === "pending") return res.json(result);
    const user = store.findUserById(result.userId);
    if (!user || user.disabled) throw httpError(410, "This account is no longer available.");
    startSession(req, res, user);
    if(result.remoteScreen) {
      const screen=store.ensureScreen(req);
      req.session.deviceMode='screen';
      const phone=store.sessionById(result.approverSessionId);
      if(phone && phone.user_id===user.id && phone.scope==='full') {
        store.setRemoteBrowser({user,session:{id:phone.id}},screen);
        store.joinScreen(screen.id);
      }
    }
    clearQrCookie(req, res);
    res.json({ status: "approved", auth: authStatus(req) });
  });
  app.post("/api/auth/qr/details", requireAuth, approvalLimit, (req, res) => {
    res.json(challenges.details(req.body?.id, req.body?.token));
  });
  app.post("/api/auth/qr/approve", requireAuth, approvalLimit, (req, res) => {
    challenges.approve(req.body?.id, req.body?.token, req.user.id, req.session.id);
    res.json({ ok: true });
  });
  app.post("/api/auth/qr/cancel", pollLimit, (req, res) => {
    challenges.cancel(req.body?.id, req.cookies[QR_COOKIE]);
    clearQrCookie(req, res);
    res.json({ ok: true });
  });
  return challenges;
}
