import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import App from "./App";
import PageRecovery from "./PageRecovery";
import "./styles.css";
const ScreenCheck = lazy(() => import("./ScreenCheck"));
const screenCheck = new URLSearchParams(location.search).get("screen-check") === "1";
createRoot(document.getElementById("root")!).render(
  <PageRecovery>{screenCheck
    ? <Suspense fallback={<p role="status">Opening screen check…</p>}><ScreenCheck /></Suspense>
    : <App />}</PageRecovery>,
);
