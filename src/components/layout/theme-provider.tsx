'use client';

import * as React from 'react';

type Theme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (t: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = 'codesentinel-theme';

/**
 * Dependency-free theme provider (no next-themes needed).
 * The inline script in layout.tsx applies the class before paint, so there is
 * no flash of incorrect theme.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>('system');
  const [resolved, setResolved] = React.useState<'light' | 'dark'>('dark');

  const apply = React.useCallback((next: Theme) => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = next === 'system' ? (prefersDark ? 'dark' : 'light') : next;
    document.documentElement.classList.toggle('dark', effective === 'dark');
    setResolved(effective);
  }, []);

  React.useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? 'system';
    setThemeState(stored);
    apply(stored);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if ((localStorage.getItem(STORAGE_KEY) as Theme | null ?? 'system') === 'system') apply('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [apply]);

  const setTheme = React.useCallback(
    (next: Theme) => {
      localStorage.setItem(STORAGE_KEY, next);
      setThemeState(next);
      apply(next);
    },
    [apply],
  );

  const value = React.useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/** Blocking script that prevents a flash of the wrong theme. */
export const THEME_SCRIPT = `
(function(){try{
  var s=localStorage.getItem('${STORAGE_KEY}')||'system';
  var d=s==='dark'||(s==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark',d);
}catch(e){document.documentElement.classList.add('dark');}})();
`;
