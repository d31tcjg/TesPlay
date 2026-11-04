import { rateLimit } from "express-rate-limit";
import { httpError, randomToken } from "./security.js";

const dimensions = ["width", "height", "availableWidth", "availableHeight", "viewportWidth", "viewportHeight", "outerWidth", "outerHeight", "visualWidth", "visualHeight"];
const required = new Set(["width", "height", "viewportWidth", "viewportHeight", "pixelRatio"]);

export function registerScreenCheckRoutes(app, { onReport = report => console.info("tesplay-screen-check", JSON.stringify(report)) } = {}) {
  // This is opt-in troubleshooting. Normal visits never submit a report.
  const limit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Try the screen check again in a minute." } });
  app.post("/api/screen-check", limit, (req, res) => {
    const value = req.body;
    if (!value || typeof value.userAgent !== "string" || value.userAgent.length > 1024) throw httpError(400, "Browser identity is required.");
    const report = { id: randomToken(9), at: new Date().toISOString(), userAgent: value.userAgent };
    for (const field of [...dimensions, "pixelRatio", "visualScale"]) {
      if (value[field] === undefined && !required.has(field)) continue;
      const number = value[field];
      const ratio = field === "pixelRatio" || field === "visualScale";
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || (ratio && number === 0) || number > (ratio ? 16 : 20_000)) throw httpError(400, "Invalid display readings.");
      report[field] = number;
    }
    // Never log request cookies, account IDs, URLs or unrecognised body fields.
    onReport(report);
    res.json({ id: report.id });
  });
}
