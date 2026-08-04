import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import ConsolePage from "./pages/ConsolePage";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/console" element={<ConsolePage />} />
        {/* Same page — the host is a route param so the console is linkable and
            survives a reload. Without a host it redirects to the first one. */}
        <Route path="/console/hosts/:host" element={<ConsolePage />} />
        {/* Unknown paths go home rather than rendering a blank screen. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
