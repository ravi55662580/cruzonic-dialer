'use client';

import { useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useRouter } from 'next/navigation';
import ThemeToggle from '@/components/ThemeToggle';
import {
    Phone,
    Sparkles,
    Mic,
    BarChart3,
    AlertTriangle,
    ICON_DEFAULTS,
} from '@/components/Icon';

/**
 * Login screen.
 *
 * Split-screen layout: a marketing/hero panel on the left with a stylised
 * animated dialer visual (ring pulses + sound-wave bars + drifting AI
 * suggestion chips), and the credentials form on the right. Mesh-gradient
 * background slowly shifts behind everything. Animation respects
 * `prefers-reduced-motion`.
 */
export default function LoginPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { signIn } = useAuth();
    const router = useRouter();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        const result = await signIn(email, password);
        if (result.error) {
            setError(result.error);
            setLoading(false);
        } else {
            router.push('/');
        }
    };

    return (
        <div className="login-shell">
            {/* Animated mesh background — three blurred blobs that drift */}
            <div aria-hidden="true" className="login-mesh">
                <div className="login-blob login-blob-1" />
                <div className="login-blob login-blob-2" />
                <div className="login-blob login-blob-3" />
            </div>

            <div className="login-grid">
                {/* ── Hero panel (left on desktop, top on mobile) ── */}
                <aside className="login-hero">
                    <div className="login-brand">
                        <span className="login-brand-mark">
                            <Phone {...ICON_DEFAULTS} size={20} strokeWidth={2.5} />
                        </span>
                        <span className="login-brand-name">Cruzonic Dialer</span>
                    </div>

                    <div className="login-hero-body">
                        <h1 className="login-hero-title">
                            AI-powered sales coaching that{' '}
                            <span className="login-hero-accent">listens, suggests, and closes</span>.
                        </h1>
                        <p className="login-hero-sub">
                            Live transcription, real-time reply suggestions, post-call summaries —
                            all in one cloud dialer.
                        </p>

                        {/* The visual: phone with concentric ring pulses, a waveform
                            underneath, and three floating AI chips around it. */}
                        <div className="login-stage" aria-hidden="true">
                            <div className="login-phone-pulse">
                                <span className="ring ring-1" />
                                <span className="ring ring-2" />
                                <span className="ring ring-3" />
                                <span className="phone-core">
                                    <Phone size={36} strokeWidth={2.25} aria-hidden="true" />
                                </span>
                            </div>

                            <div className="login-wave">
                                {Array.from({ length: 14 }).map((_, i) => (
                                    <span
                                        key={i}
                                        className="wave-bar"
                                        style={{ animationDelay: `${i * 60}ms` }}
                                    />
                                ))}
                            </div>

                            <div className="login-chip login-chip-1">
                                <Sparkles size={12} strokeWidth={2.25} aria-hidden="true" />
                                <span>“Try anchoring on value before price.”</span>
                            </div>
                            <div className="login-chip login-chip-2">
                                <Mic size={12} strokeWidth={2.25} aria-hidden="true" />
                                <span>Live transcript · 0.4s latency</span>
                            </div>
                            <div className="login-chip login-chip-3">
                                <BarChart3 size={12} strokeWidth={2.25} aria-hidden="true" />
                                <span>Wrap-up summary ready</span>
                            </div>
                        </div>
                    </div>

                    <ul className="login-features" aria-label="Product features">
                        <li><span className="login-feature-dot" /> Live transcription</li>
                        <li><span className="login-feature-dot" /> AI reply suggestions</li>
                        <li><span className="login-feature-dot" /> Post-call summaries</li>
                    </ul>
                </aside>

                {/* ── Form panel (right on desktop, bottom on mobile) ── */}
                <main className="login-panel">
                    <div className="login-panel-theme"><ThemeToggle /></div>

                    <div className="login-card">
                        <header className="login-card-head">
                            <h2>Welcome back</h2>
                            <p>Sign in to your Cruzonic workspace.</p>
                        </header>

                        <form onSubmit={handleLogin} className="login-form" noValidate>
                            {error && (
                                <div className="login-error" role="alert">
                                    <AlertTriangle {...ICON_DEFAULTS} size={14} />
                                    <span>{error}</span>
                                </div>
                            )}

                            <div className="form-group">
                                <label htmlFor="email">Work email</label>
                                <input
                                    id="email"
                                    type="email"
                                    autoComplete="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="agent@cruzonic.com"
                                    required
                                    autoFocus
                                />
                            </div>

                            <div className="form-group">
                                <label htmlFor="password">Password</label>
                                <input
                                    id="password"
                                    type="password"
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="••••••••"
                                    required
                                />
                            </div>

                            <button
                                type="submit"
                                className="btn-login"
                                disabled={loading || !email || !password}
                            >
                                {loading ? (
                                    <>
                                        <span className="spinner" aria-hidden="true" />
                                        Signing in…
                                    </>
                                ) : (
                                    <>
                                        Sign in
                                        <span className="login-arrow" aria-hidden="true">→</span>
                                    </>
                                )}
                            </button>
                        </form>

                        <footer className="login-foot">
                            Need access? <span>Ask your admin to invite you.</span>
                        </footer>
                    </div>
                </main>
            </div>
        </div>
    );
}
