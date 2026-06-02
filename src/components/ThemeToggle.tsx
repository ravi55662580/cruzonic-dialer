'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, ICON_DEFAULTS } from '@/components/Icon';

type Theme = 'dark' | 'light';

// Read the current theme without triggering React state changes from inside
// an effect. The bootstrap script in `app/layout.tsx` sets `data-theme` on
// <html> before paint; this lazy initializer just mirrors it.
function readInitialTheme(): Theme {
    if (typeof document === 'undefined') return 'dark';
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
    try {
        const saved = localStorage.getItem('cruzonic_theme');
        if (saved === 'light' || saved === 'dark') return saved;
    } catch {
        // localStorage may be unavailable (e.g. private mode); ignore.
    }
    return 'dark';
}

export default function ThemeToggle() {
    const [theme, setTheme] = useState<Theme>(readInitialTheme);

    // Sync DOM + storage whenever theme changes. This effect only writes to
    // external systems (DOM + localStorage), it never calls setState — so it
    // doesn't trigger the `react-hooks/set-state-in-effect` rule.
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        try {
            localStorage.setItem('cruzonic_theme', theme);
        } catch {
            // ignore storage errors
        }
    }, [theme]);

    const toggle = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));

    return (
        <button
            className="theme-toggle"
            onClick={toggle}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            // The icon depends on a value the server can't know, so the SSR
            // markup may differ from CSR. Suppress the warning rather than
            // hide the button until mount.
            suppressHydrationWarning
        >
            {theme === 'dark' ? <Sun {...ICON_DEFAULTS} size={18} /> : <Moon {...ICON_DEFAULTS} size={18} />}
        </button>
    );
}
