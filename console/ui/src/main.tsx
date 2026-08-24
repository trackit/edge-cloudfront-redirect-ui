import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import ConsolePage from "./pages/ConsolePage";
import LoginPage from "./pages/LoginPage";
import AuthCallback from "./pages/AuthCallback";
import RequireAuth from "./components/RequireAuth";
import { AuthProvider } from "./auth/AuthProvider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* Outside the routes: the session is asked for once per page load, not
          once per navigation, and the landing page shows who is signed in. */}
      <AuthProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          {/* Not guarded — it is how you become signed in. */}
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route
            path="/console"
            element={
              <RequireAuth>
                <ConsolePage />
              </RequireAuth>
            }
          />
          {/* Same page — the host is a route param so the console is linkable and
              survives a reload. Without a host it redirects to the first one. */}
          <Route
            path="/console/hosts/:host"
            element={
              <RequireAuth>
                <ConsolePage />
              </RequireAuth>
            }
          />
          {/* Unknown paths go home rather than rendering a blank screen. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
