import { SESSION_COOKIE, cleanText, httpError } from "./security.js";
export function registerProfileRoutes(
  app,
  { store, getProfileId, authStatus },
) {
  app.get("/api/profiles", (req, res) =>
    res.json({
      profiles: store.profiles(req.user.id),
      activeProfileId: req.session.profileId,
    }),
  );
  app.post("/api/profiles", (req, res) => {
    const name = cleanText(req.body?.name, "Profile name", 40);
    const color = req.body?.color ?? "#d6ff5f";
    if (!/^#[0-9a-fA-F]{6}$/.test(color))
      throw httpError(400, "Choose a six-digit profile color.");
    store.createProfile(req.user.id, name, color);
    res.status(201).json({
      profiles: store.profiles(req.user.id),
      activeProfileId: req.session.profileId,
    });
  });
  app.get("/api/player/preferences", (req, res) =>
    res.json(store.playerPreferences(req.user.id, getProfileId(req))),
  );
  app.patch("/api/player/preferences", (req, res) => {
    res.json(
      store.savePlayerPreferences(req.user.id, getProfileId(req), req.body),
    );
  });
  app.post("/api/profiles/:id/select", (req, res) => {
    store.selectProfile(req.user.id, req.session.id, req.params.id);
    req.session.profileId = req.params.id;
    req.session.deviceMode = "browser";
    req.session.remoteRoomId = null;
    res.json(authStatus(req));
  });
  app.delete("/api/profiles/:id", (req, res) => {
    store.deleteProfile(req.user.id, req.params.id);
    const current = store.getSession(req.cookies[SESSION_COOKIE]);
    req.session = current.session;
    res.json({
      profiles: store.profiles(req.user.id),
      activeProfileId: req.session.profileId,
    });
  });
}
