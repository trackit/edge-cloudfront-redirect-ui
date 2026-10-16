import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type Theme = "light" | "dark";

/**
 * The viewer's own choice, per browser. Read before first paint by the inline
 * script in index.html too, so the two must agree on this key.
 */
export const THEME_KEY = "edgeroute.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

const isTheme = (value: unknown): value is Theme =>
  value === "light" || value === "dark";

/** The stored choice, or `null` for none. Storage can throw (private mode). */
export const storedTheme = (): Theme | null => {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
};

const systemTheme = (): Theme =>
  window.matchMedia?.(DARK_QUERY).matches === true ? "dark" : "light";

const ThemeContext = createContext<[Theme, (theme: Theme) => void] | undefined>(
  undefined,
);

/**
 * Owns the console's theme, once, at the root: every page follows the system
 * the same way, whether or not it shows the profile menu.
 *
 * Follows the operating system until the switch is used; from then on the
 * choice sticks — in this browser when storage works, and for this visit when
 * it does not.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(
    () => storedTheme() ?? systemTheme(),
  );
  // Set by the switch, so a choice outranks the system even where storage
  // throws and `storedTheme` cannot remember it.
  const chosen = useRef(storedTheme() !== null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (query === undefined) return;
    const onChange = (): void => {
      if (!chosen.current) setTheme(systemTheme());
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const choose = (next: Theme): void => {
    chosen.current = true;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not remembered, but still applied for this visit.
    }
    setTheme(next);
  };

  return (
    <ThemeContext.Provider value={[theme, choose]}>
      {children}
    </ThemeContext.Provider>
  );
}

/** The theme and the way to change it. Throws outside <ThemeProvider>. */
export const useTheme = (): [Theme, (theme: Theme) => void] => {
  const value = useContext(ThemeContext);
  if (value === undefined) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return value;
};
