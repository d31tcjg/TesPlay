import { useEffect, useState } from "react";
import { isTeslaBrowser, isTeslaRearScreen } from "./rear-screen";
import "./screen-check.css";

function readScreen() {
  return {
    userAgent: navigator.userAgent,
    width: screen.width,
    height: screen.height,
    pixelRatio: devicePixelRatio,
    availableWidth: screen.availWidth,
    availableHeight: screen.availHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    outerWidth,
    outerHeight,
    visualWidth: visualViewport?.width ?? innerWidth,
    visualHeight: visualViewport?.height ?? innerHeight,
    visualScale: visualViewport?.scale ?? 1,
  };
}

export default function ScreenCheck() {
  const [report] = useState(readScreen);
  const [status, setStatus] = useState("Sending display readings…");
  const tesla = isTeslaBrowser(report.userAgent);
  const rear = isTeslaRearScreen(report);
  useEffect(() => {
    let active = true;
    fetch("/api/screen-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    }).then(async response => {
      if (!response.ok) throw new Error("Could not send readings");
      const result: { id: string } = await response.json();
      if (active) setStatus(`Readings sent. Check code: ${result.id}`);
    }).catch(() => {
      if (active) setStatus("Could not send readings. Share the values shown below.");
    });
    return () => { active = false; };
  }, [report]);

  return <main className="screen-check">
    <section className="screen-check-card">
      <p className="screen-check-brand">TesPlay.</p>
      <h1>Screen check</h1>
      <p>Open this page on the Tesla rear screen. It sends only the browser identity and display sizes to TesPlay’s server log for troubleshooting.</p>
      <p className="screen-check-status" role="status">{status}</p>
      <dl>
        <div><dt>Tesla browser recognised</dt><dd>{tesla ? "Yes" : "No"}</dd></div>
        <div><dt>Rear display match</dt><dd>{rear ? "Yes" : "No"}</dd></div>
        <div><dt>Reported screen (CSS pixels)</dt><dd>{report.width} × {report.height}</dd></div>
        <div><dt>Pixel ratio</dt><dd>{report.pixelRatio}</dd></div>
        <div><dt>Scaled pixel estimate</dt><dd>{Math.round(report.width * report.pixelRatio)} × {Math.round(report.height * report.pixelRatio)}</dd></div>
        <div><dt>Page area (CSS pixels)</dt><dd>{report.viewportWidth} × {report.viewportHeight}</dd></div>
      </dl>
      <p>Accepted rear screen sizes: 1280 × 720 (measured browser report) or 1280 × 800 (panel specification), accounting for scaling. Browser zoom can affect these readings.</p>
      <details><summary>Browser identity</summary><p className="screen-check-agent">{report.userAgent}</p></details>
      <a className="screen-check-return" href="/?rear-check=2">Return to TesPlay</a>
    </section>
  </main>;
}
