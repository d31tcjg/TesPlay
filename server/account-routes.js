import {
  cleanText,
  hashPassword,
  httpError,
  validateEmail,
  validatePassword,
} from "./security.js";
import { validateGrants } from "./access.js";
import { validateUsername } from "./auth-context.js";
import {
  validatePlayerPreferences,
  defaultPlayerPreferences,
} from "./player-preferences.js";
export function registerAccountRoutes(app, { store, requireOwner, qrAuth }) {
  app.use("/api/accounts", requireOwner);
  app.get("/api/accounts", (req, res) =>
    res.json({ accounts: store.listAccounts() }),
  );
  app.post("/api/accounts", async (req, res) => {
    const name = cleanText(req.body?.name, "Name", 60),
      username =
        req.body?.username === undefined
          ? undefined
          : validateUsername(req.body.username),
      email = username ? undefined : validateEmail(req.body?.email),
      password = validatePassword(req.body?.password);
    const grants = validateGrants(
      req.body?.grants || [],
      store.listConnections(req.user.id),
    );
    const playbackDefaults =
      req.body?.playbackDefaults === undefined
        ? defaultPlayerPreferences
        : validatePlayerPreferences(req.body.playbackDefaults);
    const account = store.createMember({
      name,
      email,
      username,
      passwordHash: await hashPassword(password),
      grants,
      playbackDefaults,
    });
    res.status(201).json({ account });
  });
  app.patch("/api/accounts/:id", async (req, res) => {
    const update = {};
    if (req.body?.name !== undefined)
      update.name = cleanText(req.body.name, "Name", 60);
    if (req.body?.disabled !== undefined) {
      if (typeof req.body.disabled !== "boolean")
        throw httpError(400, "Choose whether this account is enabled.");
      update.disabled = req.body.disabled;
    }
    if (req.body?.grants !== undefined)
      update.grants = validateGrants(
        req.body.grants,
        store.listConnections(req.user.id),
      );
    if (req.body?.password !== undefined)
      update.passwordHash = await hashPassword(
        validatePassword(req.body.password),
      );
    store.updateMember(req.params.id, update);
    if (update.passwordHash || update.disabled)
      qrAuth.revokeUser(req.params.id);
    res.json({ accounts: store.listAccounts() });
  });
  app.delete("/api/accounts/:id", (req, res) => {
    store.deleteMember(req.params.id);
    qrAuth.revokeUser(req.params.id);
    res.json({ ok: true });
  });
}
