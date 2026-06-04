'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import ThemeToggle from '@/components/ThemeToggle';
import {
    loadKnownColumns,
    loadCallCardConfig,
    saveCallCardConfig,
    buildDefaultConfig,
    labelForField,
    iconForField,
    type CallCardField,
} from '@/lib/callCardConfig';
import { formatPhone, formatDuration as fmtDur } from '@/lib/format';
import {
    Settings, BarChart3, Activity, Users, ListChecks, Ban, LayoutGrid,
    Phone, LogOut, RotateCcw, Save, Trash2, ChevronUp, ChevronDown,
    PhoneIncoming, PhoneOutgoing, X, Check, Clock, Mic, AlertTriangle,
    Zap, Upload,
    ICON_DEFAULTS,
} from '@/components/Icon';

interface Agent {
    id: string;
    email: string;
    full_name: string | null;
    role: string;
    is_active: boolean;
    created_at: string;
}

interface CallLogEntry {
    id: number;
    number: string;
    direction: string;
    duration: number;
    disposition: string;
    agent_name: string | null;
    agent_id: string | null;
    recording_url: string | null;
    notes: string | null;
    created_at: string;
}

interface AgentLiveStatus {
    agent_id: string;
    agent_name: string;
    status: string;
    current_call_number: string;
    /** Twilio Call SID — present only while the agent is on a call.
     *  Used by the admin Listen-in button. */
    current_call_sid?: string | null;
    last_updated: string;
}

interface DncEntry {
    id: string;
    phone: string;
    reason: string;
    created_at: string;
}

interface Analytics {
    totalCalls: number;
    avgDuration: number;
    totalDuration: number;
    dispositions: Record<string, number>;
    directions: Record<string, number>;
    callsPerDay: Record<string, number>;
    agentPerformance: { name: string; calls: number; avgDuration: number }[];
}

export default function AdminPage() {
    const { profile, loading: authLoading, isAdmin, signOut } = useAuth();
    const router = useRouter();
    const [agents, setAgents] = useState<Agent[]>([]);
    const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);
    const [activeSection, setActiveSection] = useState<'analytics' | 'agents' | 'logs' | 'status' | 'dnc' | 'callcard' | 'support' | 'powerdial'>('analytics');

    // ── Power Dial: admin-assigned lead lists ──────────────────────
    interface AssignedLeadList {
        id: number;
        name: string;
        agent_id: string | null;
        agent_name: string | null;
        agent_email: string | null;
        notes: string | null;
        lead_count: number;
        created_at: string;
    }
    const [assignedLists, setAssignedLists] = useState<AssignedLeadList[]>([]);
    const [pdName, setPdName] = useState('');
    const [pdAssignTo, setPdAssignTo] = useState('');
    const [pdNotes, setPdNotes] = useState('');
    const [pdFile, setPdFile] = useState<File | null>(null);
    const [pdBusy, setPdBusy] = useState(false);
    const [pdError, setPdError] = useState('');

    // ── Support section state ──────────────────────────────────────────
    interface SupportShift {
        id: number;
        agent_name: string;
        phone_number: string;
        shift_start_hour: number;
        shift_end_hour: number;
        is_active: boolean;
        is_current_shift?: boolean;
    }
    const [supportShifts, setSupportShifts] = useState<SupportShift[]>([]);
    const [supportCurrentHour, setSupportCurrentHour] = useState<number | null>(null);
    const [supportConfig, setSupportConfig] = useState<{
        supportNumber: string | null;
        salesNumber: string | null;
        legacyNumber: string | null;
    } | null>(null);
    const [newShiftName, setNewShiftName] = useState('');
    const [newShiftPhone, setNewShiftPhone] = useState('+91');
    const [newShiftStart, setNewShiftStart] = useState(9);
    const [newShiftEnd, setNewShiftEnd] = useState(18);
    const [shiftBusy, setShiftBusy] = useState(false);

    // ── Live listen state ─────────────────────────────────────────────
    const [listenTarget, setListenTarget] = useState<AgentLiveStatus | null>(null);
    const [listenPhone, setListenPhone] = useState('');
    const [listenBusy, setListenBusy] = useState(false);
    const [listenError, setListenError] = useState('');
    const [listenSuccess, setListenSuccess] = useState('');

    useEffect(() => {
        // Persist + restore the admin's monitor phone so they don't retype it.
        if (typeof window === 'undefined') return;
        const saved = window.localStorage.getItem('cruzonic_admin_listen_phone');
        if (saved) setListenPhone(saved);
    }, []);

    // ── Power Dial list fetching + upload ──────────────────────────────
    const fetchAssignedLists = useCallback(async () => {
        try {
            const res = await fetch('/api/lead-lists');
            const data = await res.json();
            if (Array.isArray(data.lists)) setAssignedLists(data.lists);
        } catch (err) {
            console.warn('fetch assigned lists failed', err);
        }
    }, []);

    useEffect(() => {
        if (activeSection !== 'powerdial') return;
        fetchAssignedLists();
    }, [activeSection, fetchAssignedLists]);

    /** Tiny CSV line parser — same logic as the agent's dialer page, kept
     *  inline here to avoid creating a shared lib until it's worth it. */
    const parseCsvLine = (line: string): string[] => {
        const out: string[] = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (c === '"') {
                if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
                else { inQ = !inQ; }
            } else if (c === ',' && !inQ) {
                out.push(cur);
                cur = '';
            } else {
                cur += c;
            }
        }
        out.push(cur);
        return out.map((x) => x.trim());
    };

    const uploadPowerDial = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!pdFile || !pdName.trim()) return;
        setPdBusy(true);
        setPdError('');

        try {
            const text = await pdFile.text();
            const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
            if (lines.length < 2) throw new Error('CSV needs a header row + at least 1 lead');

            const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
            const idx = (...names: string[]) =>
                names.map((n) => headers.indexOf(n)).find((i) => i >= 0) ?? -1;

            const phoneCol = idx('phone', 'phone_number', 'mobile', 'number');
            if (phoneCol < 0) throw new Error('CSV must have a "phone" column');

            const leads: Record<string, unknown>[] = [];
            for (let r = 1; r < lines.length; r++) {
                const cells = parseCsvLine(lines[r]);
                const phone = cells[phoneCol] || '';
                if (!phone) continue;
                const lead: Record<string, unknown> = {
                    phone,
                    first_name: cells[idx('first_name', 'firstname', 'first name')] || '',
                    last_name: cells[idx('last_name', 'lastname', 'last name')] || '',
                    company: cells[idx('company', 'organization', 'org')] || '',
                    email: cells[idx('email')] || '',
                    city: cells[idx('city')] || '',
                    state: cells[idx('state')] || '',
                    custom1: cells[idx('custom1')] || '',
                    custom2: cells[idx('custom2')] || '',
                    custom3: cells[idx('custom3')] || '',
                };
                // Capture every remaining column verbatim into `extra` so the
                // agent's Call Card can show them later via callCardConfig.
                const known = new Set([phoneCol, idx('first_name', 'firstname', 'first name'),
                    idx('last_name', 'lastname', 'last name'),
                    idx('company', 'organization', 'org'),
                    idx('email'), idx('city'), idx('state'),
                    idx('custom1'), idx('custom2'), idx('custom3')]);
                const extra: Record<string, string> = {};
                for (let c = 0; c < headers.length; c++) {
                    if (known.has(c)) continue;
                    if (!headers[c]) continue;
                    extra[headers[c]] = cells[c] || '';
                }
                lead.extra = extra;
                leads.push(lead);
            }

            const res = await fetch('/api/lead-lists', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: pdName.trim(),
                    agent_id: pdAssignTo || null,
                    notes: pdNotes.trim() || null,
                    created_by: profile?.id || null,
                    leads,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload failed');

            setSuccess(`Uploaded ${leads.length} leads to "${pdName.trim()}"`);
            setPdName('');
            setPdAssignTo('');
            setPdNotes('');
            setPdFile(null);
            fetchAssignedLists();
        } catch (err: unknown) {
            setPdError(err instanceof Error ? err.message : 'Upload failed');
        } finally {
            setPdBusy(false);
        }
    };

    const deleteAssignedList = async (id: number) => {
        try {
            await fetch(`/api/lead-lists?id=${id}`, { method: 'DELETE' });
            fetchAssignedLists();
        } catch (err) {
            console.warn('delete list failed', err);
        }
    };

    const startListen = async () => {
        if (!listenTarget?.current_call_sid || !listenPhone.trim()) return;
        setListenBusy(true);
        setListenError('');
        try {
            const res = await fetch('/api/twilio/monitor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentCallSid: listenTarget.current_call_sid,
                    adminPhone: listenPhone.trim(),
                    adminEmail: profile?.email,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Listen-in failed');
            window.localStorage.setItem('cruzonic_admin_listen_phone', listenPhone.trim());
            setListenSuccess(`Calling ${listenPhone.trim()} — pick up to listen. You'll be muted.`);
            setTimeout(() => setListenSuccess(''), 5000);
            setListenTarget(null);
        } catch (err: unknown) {
            setListenError(err instanceof Error ? err.message : 'Listen-in failed');
        } finally {
            setListenBusy(false);
        }
    };
    const [showCreateForm, setShowCreateForm] = useState(false);
    const [newEmail, setNewEmail] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newName, setNewName] = useState('');
    const [newRole, setNewRole] = useState('sales');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [creating, setCreating] = useState(false);
    const [agentStatuses, setAgentStatuses] = useState<AgentLiveStatus[]>([]);
    const [dncList, setDncList] = useState<DncEntry[]>([]);
    const [dncPhone, setDncPhone] = useState('');
    const [dncReason, setDncReason] = useState('');
    const [analytics, setAnalytics] = useState<Analytics | null>(null);
    const [knownColumns, setKnownColumns] = useState<string[]>([]);
    const [cardConfig, setCardConfig] = useState<CallCardField[]>([]);
    const [cardSaved, setCardSaved] = useState(false);

    useEffect(() => {
        if (!authLoading && !isAdmin) {
            router.push('/');
        }
    }, [authLoading, isAdmin, router]);

    const fetchAgents = useCallback(async () => {
        const { data } = await supabase
            .from('profiles')
            .select('*')
            .order('created_at', { ascending: false });
        if (data) setAgents(data);
    }, []);

    const fetchAllLogs = useCallback(async () => {
        try {
            const res = await fetch('/api/call-logs');
            const json = await res.json();
            if (json.logs) setCallLogs(json.logs as CallLogEntry[]);
        } catch (err) {
            console.error('Failed to fetch call logs:', err);
        }
    }, []);

    const fetchAgentStatuses = useCallback(async () => {
        try {
            const res = await fetch('/api/agent-status');
            const json = await res.json();
            if (json.statuses) setAgentStatuses(json.statuses);
        } catch { }
    }, []);

    const fetchDnc = useCallback(async () => {
        try {
            const res = await fetch('/api/dnc');
            const json = await res.json();
            if (json.numbers) setDncList(json.numbers);
        } catch { }
    }, []);

    const fetchAnalytics = useCallback(async () => {
        try {
            const res = await fetch('/api/analytics');
            const json = await res.json();
            setAnalytics(json);
        } catch { }
    }, []);

    useEffect(() => {
        if (isAdmin) {
            fetchAgents();
            fetchAllLogs();
            fetchAgentStatuses();
            fetchDnc();
            fetchAnalytics();
            // Poll agent statuses every 10s
            const interval = setInterval(fetchAgentStatuses, 10000);
            return () => clearInterval(interval);
        }
    }, [isAdmin, fetchAgents, fetchAllLogs, fetchAgentStatuses, fetchDnc, fetchAnalytics]);

    // Load the call-card config + the columns the importer has ever seen.
    // Re-runs when the admin opens the section so newly-uploaded CSVs show up.
    useEffect(() => {
        if (!isAdmin || activeSection !== 'callcard') return;
        const cols = loadKnownColumns();
        setKnownColumns(cols);
        const stored = loadCallCardConfig();
        if (stored && stored.length > 0) {
            // Append newly-seen columns so the editor doesn't hide them.
            const known = new Set(stored.map((s) => s.key));
            const extras = cols
                .filter((c) => !known.has(c))
                .map<CallCardField>((key) => ({ key, enabled: true }));
            setCardConfig([...stored, ...extras]);
        } else {
            setCardConfig(buildDefaultConfig(cols));
        }
        setCardSaved(false);
    }, [isAdmin, activeSection]);

    const moveCardField = (idx: number, dir: -1 | 1) => {
        setCardConfig((prev) => {
            const next = [...prev];
            const target = idx + dir;
            if (target < 0 || target >= next.length) return prev;
            [next[idx], next[target]] = [next[target], next[idx]];
            return next;
        });
        setCardSaved(false);
    };

    const toggleCardField = (idx: number) => {
        setCardConfig((prev) =>
            prev.map((f, i) => (i === idx ? { ...f, enabled: !f.enabled } : f))
        );
        setCardSaved(false);
    };

    const saveCardConfig = () => {
        saveCallCardConfig(cardConfig);
        setCardSaved(true);
        // Other tabs / open dialer windows need to know we changed it.
        // The `storage` event doesn't fire in the same tab, so dispatch
        // a manual one for consumers in this window.
        window.dispatchEvent(new StorageEvent('storage', { key: 'cruzonic_call_card_config' }));
    };

    const resetCardConfig = () => {
        setCardConfig(buildDefaultConfig(knownColumns));
        setCardSaved(false);
    };

    const createAgent = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        setCreating(true);

        try {
            const res = await fetch('/api/admin/agents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: newEmail,
                    password: newPassword,
                    full_name: newName,
                    role: newRole,
                }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to create agent');

            setSuccess(`Agent ${newEmail} created successfully!`);
            setNewEmail('');
            setNewPassword('');
            setNewName('');
            setNewRole('agent');
            setShowCreateForm(false);
            fetchAgents();
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to create agent';
            setError(errorMessage);
        } finally {
            setCreating(false);
        }
    };

    const toggleAgent = async (agentId: string, isActive: boolean) => {
        await supabase
            .from('profiles')
            .update({ is_active: !isActive })
            .eq('id', agentId);
        fetchAgents();
    };

    const changeAgentRole = async (agentId: string, role: string) => {
        try {
            await fetch('/api/admin/agents', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: agentId, role }),
            });
            fetchAgents();
        } catch (err) {
            console.warn('role change failed', err);
        }
    };

    // ── Support shift data fetching ────────────────────────────────────
    const fetchSupportShifts = useCallback(async () => {
        try {
            const res = await fetch('/api/support-shifts');
            const data = await res.json();
            if (Array.isArray(data.shifts)) {
                setSupportShifts(data.shifts);
                setSupportCurrentHour(
                    typeof data.currentHourIST === 'number' ? data.currentHourIST : null,
                );
            }
        } catch (err) {
            console.warn('fetch support-shifts failed', err);
        }
    }, []);

    const fetchSupportConfig = useCallback(async () => {
        try {
            const res = await fetch('/api/admin/support-config');
            if (res.ok) setSupportConfig(await res.json());
        } catch (err) {
            console.warn('fetch support-config failed', err);
        }
    }, []);

    useEffect(() => {
        if (activeSection !== 'support') return;
        fetchSupportShifts();
        fetchSupportConfig();
        // Re-poll every 60s so the "current shift" indicator stays accurate
        // (matches IST hour changes without a manual refresh).
        const t = setInterval(fetchSupportShifts, 60_000);
        return () => clearInterval(t);
    }, [activeSection, fetchSupportShifts, fetchSupportConfig]);

    const createShift = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newShiftName.trim() || !newShiftPhone.trim()) return;
        setShiftBusy(true);
        try {
            const res = await fetch('/api/support-shifts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agent_name: newShiftName.trim(),
                    phone_number: newShiftPhone.trim(),
                    shift_start_hour: newShiftStart,
                    shift_end_hour: newShiftEnd,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to create shift');
            setSuccess(`Shift added for ${newShiftName}`);
            setNewShiftName('');
            setNewShiftPhone('+91');
            setNewShiftStart(9);
            setNewShiftEnd(18);
            fetchSupportShifts();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Failed to create shift');
        } finally {
            setShiftBusy(false);
        }
    };

    const updateShift = async (id: number, patch: Partial<SupportShift>) => {
        try {
            await fetch('/api/support-shifts', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ...patch }),
            });
            fetchSupportShifts();
        } catch (err) {
            console.warn('update shift failed', err);
        }
    };

    const deleteShift = async (id: number) => {
        try {
            await fetch(`/api/support-shifts?id=${id}`, { method: 'DELETE' });
            fetchSupportShifts();
        } catch (err) {
            console.warn('delete shift failed', err);
        }
    };

    const addDnc = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!dncPhone.trim()) return;
        try {
            await fetch('/api/dnc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: dncPhone, reason: dncReason, added_by: profile?.id }),
            });
            setDncPhone('');
            setDncReason('');
            fetchDnc();
        } catch { }
    };

    const removeDnc = async (id: string) => {
        try {
            await fetch(`/api/dnc?id=${id}`, { method: 'DELETE' });
            fetchDnc();
        } catch { }
    };

    const formatDuration = fmtDur;

    const statusColor = (status: string) => {
        switch (status) {
            case 'ready': return '#10b981';
            case 'on-call': return '#ef4444';
            case 'connecting': return '#f59e0b';
            case 'wrap-up': return '#8b5cf6';
            default: return '#666666';
        }
    };

    if (authLoading) {
        return (
            <div className="login-page">
                <div className="login-card"><p style={{ textAlign: 'center', padding: '40px' }}>Loading...</p></div>
            </div>
        );
    }

    if (!isAdmin) return null;

    // Analytics helpers
    const maxCallsPerDay = analytics ? Math.max(...Object.values(analytics.callsPerDay), 1) : 1;

    return (
        <div className="dashboard">
            <header className="dashboard-header">
                <div className="logo">
                    <span className="logo-icon"><Settings {...ICON_DEFAULTS} size={18} /></span>
                    <h1>Admin Dashboard</h1>
                    <ThemeToggle />
                </div>
                <nav className="nav-tabs">
                    <button className={`nav-tab ${activeSection === 'analytics' ? 'active' : ''}`} onClick={() => setActiveSection('analytics')}>
                        <BarChart3 {...ICON_DEFAULTS} /> Analytics
                    </button>
                    <button className={`nav-tab ${activeSection === 'status' ? 'active' : ''}`} onClick={() => setActiveSection('status')}>
                        <Activity {...ICON_DEFAULTS} /> Live Status
                    </button>
                    <button className={`nav-tab ${activeSection === 'agents' ? 'active' : ''}`} onClick={() => setActiveSection('agents')}>
                        <Users {...ICON_DEFAULTS} /> Agents ({agents.length})
                    </button>
                    <button className={`nav-tab ${activeSection === 'logs' ? 'active' : ''}`} onClick={() => setActiveSection('logs')}>
                        <ListChecks {...ICON_DEFAULTS} /> Call Logs ({callLogs.length})
                    </button>
                    <button className={`nav-tab ${activeSection === 'dnc' ? 'active' : ''}`} onClick={() => setActiveSection('dnc')}>
                        <Ban {...ICON_DEFAULTS} /> DNC ({dncList.length})
                    </button>
                    <button className={`nav-tab ${activeSection === 'callcard' ? 'active' : ''}`} onClick={() => setActiveSection('callcard')}>
                        <LayoutGrid {...ICON_DEFAULTS} /> Call Card
                    </button>
                    <button className={`nav-tab ${activeSection === 'support' ? 'active' : ''}`} onClick={() => setActiveSection('support')}>
                        <PhoneIncoming {...ICON_DEFAULTS} /> Support
                    </button>
                    <button className={`nav-tab ${activeSection === 'powerdial' ? 'active' : ''}`} onClick={() => setActiveSection('powerdial')}>
                        <Zap {...ICON_DEFAULTS} /> Power Dial
                    </button>
                    <button className="nav-tab" onClick={() => router.push('/')}>
                        <Phone {...ICON_DEFAULTS} /> Dialer
                    </button>
                    <button className="nav-tab" onClick={signOut}>
                        <LogOut {...ICON_DEFAULTS} /> Logout
                    </button>
                </nav>
            </header>

            <main className="dashboard-main">
                {error && (
                    <div className="error-banner" style={{ marginBottom: 16 }}>
                        <span>{error}</span>
                        <button onClick={() => setError('')} aria-label="Dismiss"><X {...ICON_DEFAULTS} size={14} /></button>
                    </div>
                )}
                {success && (
                    <div className="success-banner" style={{ marginBottom: 16 }}>
                        <span><Check {...ICON_DEFAULTS} size={14} /> {success}</span>
                        <button onClick={() => setSuccess('')} aria-label="Dismiss"><X {...ICON_DEFAULTS} size={14} /></button>
                    </div>
                )}

                {/* Analytics Section */}
                {activeSection === 'analytics' && analytics && (
                    <div className="leads-page">
                        <h2 style={{ fontSize: 18, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <BarChart3 {...ICON_DEFAULTS} size={18} /> Call Analytics
                        </h2>

                        {/* Stats Cards */}
                        <div className="admin-stats-grid">
                            <div className="admin-stat-card">
                                <div className="admin-stat-number">{analytics.totalCalls}</div>
                                <div className="admin-stat-label">Total Calls</div>
                            </div>
                            <div className="admin-stat-card">
                                <div className="admin-stat-number">{formatDuration(analytics.avgDuration)}</div>
                                <div className="admin-stat-label">Avg Duration</div>
                            </div>
                            <div className="admin-stat-card">
                                <div className="admin-stat-number">{analytics.directions?.outbound || 0}</div>
                                <div className="admin-stat-label">Outbound</div>
                            </div>
                            <div className="admin-stat-card">
                                <div className="admin-stat-number">{analytics.directions?.inbound || 0}</div>
                                <div className="admin-stat-label">Inbound</div>
                            </div>
                        </div>

                        {/* Calls Per Day Chart */}
                        <div className="admin-chart-card">
                            <h3>Calls Per Day (Last 30 Days)</h3>
                            <div className="admin-bar-chart">
                                {Object.entries(analytics.callsPerDay).map(([day, count]) => (
                                    <div key={day} className="admin-bar-col">
                                        <div className="admin-bar-value">{count > 0 ? count : ''}</div>
                                        <div
                                            className="admin-bar"
                                            style={{ height: `${(count / maxCallsPerDay) * 100}%` }}
                                        />
                                        <div className="admin-bar-label">{day.slice(5)}</div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Disposition Breakdown + Agent Performance */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                            <div className="admin-chart-card">
                                <h3>Disposition Breakdown</h3>
                                <div className="admin-dispo-list">
                                    {Object.entries(analytics.dispositions).sort((a, b) => b[1] - a[1]).map(([dispo, count]) => (
                                        <div key={dispo} className="admin-dispo-item">
                                            <span className="admin-dispo-name">{dispo}</span>
                                            <div className="admin-dispo-bar-bg">
                                                <div className="admin-dispo-bar" style={{ width: `${(count / analytics.totalCalls) * 100}%` }} />
                                            </div>
                                            <span className="admin-dispo-count">{count}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="admin-chart-card">
                                <h3>Agent Performance</h3>
                                <div className="admin-dispo-list">
                                    {analytics.agentPerformance.map(a => (
                                        <div key={a.name} className="admin-dispo-item">
                                            <span className="admin-dispo-name">{a.name}</span>
                                            <span className="admin-dispo-count">{a.calls} calls, avg {formatDuration(a.avgDuration)}</span>
                                        </div>
                                    ))}
                                    {analytics.agentPerformance.length === 0 && (
                                        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No data yet</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Agent Live Status */}
                {activeSection === 'status' && (
                    <div className="leads-page">
                        <div className="leads-toolbar">
                            <h2 style={{ flex: 1, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Activity {...ICON_DEFAULTS} size={18} /> Agent Live Status
                            </h2>
                            <button className="btn-secondary" onClick={fetchAgentStatuses}>
                                <RotateCcw {...ICON_DEFAULTS} /> Refresh
                            </button>
                        </div>
                        <div className="admin-stats-grid">
                            {agents.filter(a => a.is_active).map(agent => {
                                const live = agentStatuses.find(s => s.agent_id === agent.id);
                                const status = live?.status || 'offline';
                                return (
                                    <div key={agent.id} className="admin-stat-card" style={{ borderLeft: `4px solid ${statusColor(status)}` }}>
                                        <div className="admin-stat-label" style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
                                            {agent.full_name || agent.email}
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor(status), display: 'inline-block' }} />
                                            <span style={{ textTransform: 'uppercase', fontSize: 13, fontWeight: 600, color: statusColor(status) }}>
                                                {status}
                                            </span>
                                        </div>
                                        {live?.current_call_number && (
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                <Phone {...ICON_DEFAULTS} size={11} /> {formatPhone(live.current_call_number)}
                                            </div>
                                        )}
                                        {live?.last_updated && (
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                                                Updated: {new Date(live.last_updated).toLocaleTimeString()}
                                            </div>
                                        )}
                                        {/* Listen-in button — only when the agent is currently on a call. */}
                                        {live?.current_call_sid && status === 'on-call' && (
                                            <button
                                                className="btn-listen"
                                                onClick={() => setListenTarget(live)}
                                                title="Join this call muted — listen without being heard"
                                            >
                                                <Mic {...ICON_DEFAULTS} size={12} /> Listen in
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                            {agents.filter(a => a.is_active).length === 0 && (
                                <p style={{ color: 'var(--text-muted)', padding: 20 }}>No active agents</p>
                            )}
                        </div>
                    </div>
                )}

                {/* Agents Section */}
                {activeSection === 'agents' && (
                    <div className="leads-page">
                        <div className="leads-toolbar">
                            <h2 style={{ flex: 1, fontSize: 18 }}>Agent Management</h2>
                            <button
                                className="btn-primary"
                                onClick={() => setShowCreateForm(!showCreateForm)}
                            >
                                + Create Agent
                            </button>
                        </div>

                        {showCreateForm && (
                            <div className="admin-create-form">
                                <h3>Create New Agent</h3>
                                <form onSubmit={createAgent}>
                                    <div className="admin-form-grid">
                                        <div className="form-group">
                                            <label>Full Name</label>
                                            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="John Doe" required />
                                        </div>
                                        <div className="form-group">
                                            <label>Email</label>
                                            <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="agent@cruzoniceld.com" required />
                                        </div>
                                        <div className="form-group">
                                            <label>Password</label>
                                            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 6 characters" required minLength={6} />
                                        </div>
                                        <div className="form-group">
                                            <label>Role</label>
                                            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                                                <option value="sales">Sales (uses sales number)</option>
                                                <option value="support">Support (uses support number)</option>
                                                <option value="admin">Admin</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div className="admin-form-actions">
                                        <button type="submit" className="btn-primary" disabled={creating}>
                                            {creating ? 'Creating...' : 'Create Agent'}
                                        </button>
                                        <button type="button" className="btn-secondary" onClick={() => setShowCreateForm(false)}>
                                            Cancel
                                        </button>
                                    </div>
                                </form>
                            </div>
                        )}

                        <div className="leads-table-container">
                            <table className="leads-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Email</th>
                                        <th>Role</th>
                                        <th>Status</th>
                                        <th>Created</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {agents.map((agent) => (
                                        <tr key={agent.id}>
                                            <td className="lead-name-cell">{agent.full_name || '—'}</td>
                                            <td>{agent.email}</td>
                                            <td>
                                                <select
                                                    className={`role-select role-${agent.role}`}
                                                    value={agent.role}
                                                    onChange={(e) => changeAgentRole(agent.id, e.target.value)}
                                                    aria-label="Change role"
                                                >
                                                    <option value="sales">sales</option>
                                                    <option value="support">support</option>
                                                    <option value="admin">admin</option>
                                                    {agent.role === 'agent' && (
                                                        <option value="agent">agent (legacy)</option>
                                                    )}
                                                </select>
                                            </td>
                                            <td>
                                                <span className={`status-badge ${agent.is_active ? 'status-completed' : 'status-new'}`}>
                                                    {agent.is_active ? 'Active' : 'Disabled'}
                                                </span>
                                            </td>
                                            <td>{new Date(agent.created_at).toLocaleDateString()}</td>
                                            <td>
                                                <button
                                                    className="btn-call-small"
                                                    onClick={() => toggleAgent(agent.id, agent.is_active)}
                                                    style={agent.is_active ? { background: 'var(--accent-danger-soft)', color: 'var(--accent-danger)', borderColor: 'var(--accent-danger)' } : {}}
                                                >
                                                    {agent.is_active
                                                        ? <><Ban {...ICON_DEFAULTS} size={13} /> Disable</>
                                                        : <><Check {...ICON_DEFAULTS} size={13} /> Enable</>}
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* All Call Logs Section */}
                {activeSection === 'logs' && (
                    <div className="logs-page">
                        <h2 style={{ fontSize: 18, marginBottom: 12 }}>All Agent Call Logs</h2>
                        <div className="logs-table-container">
                            <table className="leads-table">
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>Agent</th>
                                        <th>Number</th>
                                        <th>Direction</th>
                                        <th>Duration</th>
                                        <th>Status</th>
                                        <th>Notes</th>
                                        <th>Recording</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {callLogs.map((log) => (
                                        <tr key={log.id}>
                                            <td>{new Date(log.created_at).toLocaleString()}</td>
                                            <td className="lead-name-cell">{log.agent_name || log.agent_id || '—'}</td>
                                            <td className="lead-phone-cell">{log.number ? formatPhone(log.number) : '—'}</td>
                                            <td>
                                                <span className={`direction-badge ${log.direction}`}>
                                                    {log.direction === 'outbound'
                                                        ? <PhoneOutgoing {...ICON_DEFAULTS} size={13} />
                                                        : <PhoneIncoming {...ICON_DEFAULTS} size={13} />}
                                                    {log.direction}
                                                </span>
                                            </td>
                                            <td>{formatDuration(Number(log.duration) || 0)}</td>
                                            <td>
                                                <span className={`status-badge status-${log.disposition || 'completed'}`}>{log.disposition}</span>
                                            </td>
                                            <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                                                {log.notes || '—'}
                                            </td>
                                            <td>
                                                {log.recording_url ? (
                                                    <audio controls preload="none" className="recording-player">
                                                        <source src={log.recording_url} type="audio/mpeg" />
                                                    </audio>
                                                ) : (
                                                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                    {callLogs.length === 0 && (
                                        <tr>
                                            <td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                                No call logs yet
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* DNC Section */}
                {activeSection === 'dnc' && (
                    <div className="leads-page">
                        <div className="leads-toolbar">
                            <h2 style={{ flex: 1, fontSize: 18 }}>🚫 Do Not Call List</h2>
                        </div>
                        <form onSubmit={addDnc} className="admin-create-form" style={{ marginBottom: 16 }}>
                            <div className="admin-form-grid">
                                <div className="form-group">
                                    <label>Phone Number</label>
                                    <input type="text" value={dncPhone} onChange={(e) => setDncPhone(e.target.value)} placeholder="+1234567890" required />
                                </div>
                                <div className="form-group">
                                    <label>Reason (optional)</label>
                                    <input type="text" value={dncReason} onChange={(e) => setDncReason(e.target.value)} placeholder="Requested removal" />
                                </div>
                            </div>
                            <div className="admin-form-actions">
                                <button type="submit" className="btn-primary">+ Add to DNC</button>
                            </div>
                        </form>
                        <div className="leads-table-container">
                            <table className="leads-table">
                                <thead>
                                    <tr>
                                        <th>Phone</th>
                                        <th>Reason</th>
                                        <th>Added</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {dncList.map(entry => (
                                        <tr key={entry.id}>
                                            <td className="lead-phone-cell">{entry.phone}</td>
                                            <td>{entry.reason || '—'}</td>
                                            <td>{new Date(entry.created_at).toLocaleDateString()}</td>
                                            <td>
                                                <button className="btn-call-small" onClick={() => removeDnc(entry.id)} style={{ background: 'var(--accent-danger-soft)', color: 'var(--accent-danger)', borderColor: 'var(--accent-danger)' }}>
                                                    <Trash2 {...ICON_DEFAULTS} size={13} /> Remove
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {dncList.length === 0 && (
                                        <tr>
                                            <td colSpan={4} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                                No DNC numbers
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* ───── SUPPORT SECTION ───── */}
                {activeSection === 'support' && (
                    <div className="leads-page support-page">
                        <div className="leads-toolbar">
                            <h2 style={{ flex: 1, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <PhoneIncoming {...ICON_DEFAULTS} size={18} /> Support
                            </h2>
                            {supportCurrentHour !== null && (
                                <span className="support-clock" title="Current IST hour used to pick the on-shift agent">
                                    <Clock {...ICON_DEFAULTS} size={14} /> IST {String(supportCurrentHour).padStart(2, '0')}:00
                                </span>
                            )}
                        </div>

                        {/* Configured outbound numbers */}
                        <div className="support-card">
                            <span className="support-label">Inbound support number</span>
                            <div className="support-num-row">
                                <span className="support-num">
                                    {supportConfig?.supportNumber
                                        ? formatPhone(supportConfig.supportNumber)
                                        : <em style={{ color: 'var(--text-muted)' }}>not set in env (TWILIO_SUPPORT_NUMBER)</em>}
                                </span>
                                {supportConfig?.supportNumber && (
                                    <span className="support-hint">
                                        Customers dial this. Twilio forwards to whichever shift is active below,
                                        keeping the customer&rsquo;s number as the caller ID.
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Support-role users */}
                        <div className="support-card">
                            <span className="support-label">Support agents (role = support)</span>
                            {agents.filter(a => a.role === 'support').length === 0 ? (
                                <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '6px 0 0' }}>
                                    No users with the &ldquo;support&rdquo; role yet. Create one from the
                                    Agents tab or change an existing user&rsquo;s role.
                                </p>
                            ) : (
                                <ul className="support-agents">
                                    {agents.filter(a => a.role === 'support').map(a => (
                                        <li key={a.id}>
                                            <span className={`status-dot ${a.is_active ? 'live' : ''}`} />
                                            <span className="support-agent-name">{a.full_name || a.email}</span>
                                            <span className="support-agent-email">{a.email}</span>
                                            {!a.is_active && <span className="support-agent-off">inactive</span>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>

                        {/* Shift routing */}
                        <div className="support-card">
                            <span className="support-label">Call routing by shift (IST)</span>
                            <p className="support-hint" style={{ marginTop: 4 }}>
                                When a customer calls the support number, Twilio looks for the active shift
                                whose hours include the current IST time and forwards the call to that phone.
                                Overnight shifts (e.g. 22 → 6) are supported.
                            </p>

                            <form onSubmit={createShift} className="shift-form">
                                <input
                                    type="text"
                                    value={newShiftName}
                                    onChange={(e) => setNewShiftName(e.target.value)}
                                    placeholder="Agent name"
                                    required
                                />
                                <input
                                    type="tel"
                                    value={newShiftPhone}
                                    onChange={(e) => setNewShiftPhone(e.target.value)}
                                    placeholder="+91 mobile number"
                                    required
                                />
                                <label className="shift-hour-label">
                                    From
                                    <input
                                        type="number"
                                        min={0}
                                        max={23}
                                        value={newShiftStart}
                                        onChange={(e) => setNewShiftStart(Number(e.target.value))}
                                        required
                                    />
                                </label>
                                <label className="shift-hour-label">
                                    To
                                    <input
                                        type="number"
                                        min={0}
                                        max={23}
                                        value={newShiftEnd}
                                        onChange={(e) => setNewShiftEnd(Number(e.target.value))}
                                        required
                                    />
                                </label>
                                <button type="submit" className="btn-primary" disabled={shiftBusy}>
                                    {shiftBusy ? 'Adding…' : 'Add shift'}
                                </button>
                            </form>

                            <table className="leads-table" style={{ marginTop: 12 }}>
                                <thead>
                                    <tr>
                                        <th>Status</th>
                                        <th>Agent</th>
                                        <th>Phone</th>
                                        <th>From (IST)</th>
                                        <th>To (IST)</th>
                                        <th>Active</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {supportShifts.map(s => (
                                        <tr key={s.id} className={s.is_current_shift ? 'shift-row-current' : ''}>
                                            <td>
                                                {s.is_current_shift ? (
                                                    <span className="shift-badge-now">On now</span>
                                                ) : (
                                                    <span className="status-dot" style={{ opacity: 0.4 }} />
                                                )}
                                            </td>
                                            <td>
                                                <input
                                                    type="text"
                                                    className="shift-inline-input"
                                                    defaultValue={s.agent_name}
                                                    onBlur={(e) => {
                                                        if (e.target.value !== s.agent_name) updateShift(s.id, { agent_name: e.target.value });
                                                    }}
                                                />
                                            </td>
                                            <td>
                                                <input
                                                    type="tel"
                                                    className="shift-inline-input shift-phone-input"
                                                    defaultValue={s.phone_number}
                                                    onBlur={(e) => {
                                                        if (e.target.value !== s.phone_number) updateShift(s.id, { phone_number: e.target.value });
                                                    }}
                                                />
                                            </td>
                                            <td>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    max={23}
                                                    className="shift-inline-input shift-hour-input"
                                                    defaultValue={s.shift_start_hour}
                                                    onBlur={(e) => {
                                                        const v = Number(e.target.value);
                                                        if (v !== s.shift_start_hour) updateShift(s.id, { shift_start_hour: v });
                                                    }}
                                                />
                                            </td>
                                            <td>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    max={23}
                                                    className="shift-inline-input shift-hour-input"
                                                    defaultValue={s.shift_end_hour}
                                                    onBlur={(e) => {
                                                        const v = Number(e.target.value);
                                                        if (v !== s.shift_end_hour) updateShift(s.id, { shift_end_hour: v });
                                                    }}
                                                />
                                            </td>
                                            <td>
                                                <button
                                                    className={`btn-toggle ${s.is_active ? 'on' : 'off'}`}
                                                    onClick={() => updateShift(s.id, { is_active: !s.is_active })}
                                                    title={s.is_active ? 'Click to disable' : 'Click to enable'}
                                                >
                                                    {s.is_active ? 'Active' : 'Disabled'}
                                                </button>
                                            </td>
                                            <td>
                                                <button
                                                    className="btn-icon-only"
                                                    onClick={() => deleteShift(s.id)}
                                                    aria-label={`Delete ${s.agent_name}'s shift`}
                                                >
                                                    <Trash2 {...ICON_DEFAULTS} size={14} />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {supportShifts.length === 0 && (
                                        <tr>
                                            <td colSpan={7} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>
                                                No shifts yet. Add one above to start routing calls.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* ───── POWER DIAL: admin-assigned lead lists ───── */}
                {activeSection === 'powerdial' && (
                    <div className="leads-page">
                        <div className="leads-toolbar">
                            <h2 style={{ flex: 1, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Zap {...ICON_DEFAULTS} size={18} /> Power Dial — assigned lists
                            </h2>
                        </div>

                        <div className="support-card pd-upload-card">
                            <span className="support-label">Upload &amp; assign a CSV</span>
                            <p className="support-hint" style={{ marginTop: 4 }}>
                                The assigned agent (and only that agent) sees this list on their dialer
                                under <strong>Power Dial</strong>. CSV must include a <code>phone</code>
                                column; extra columns flow through to the agent&rsquo;s Call Card.
                            </p>

                            <form onSubmit={uploadPowerDial} className="pd-upload-form">
                                <label className="form-group">
                                    <span className="pd-label">List name</span>
                                    <input
                                        type="text"
                                        value={pdName}
                                        onChange={(e) => setPdName(e.target.value)}
                                        placeholder="e.g. April outbound — Bay Area"
                                        required
                                    />
                                </label>
                                <label className="form-group">
                                    <span className="pd-label">Assign to agent</span>
                                    <select
                                        value={pdAssignTo}
                                        onChange={(e) => setPdAssignTo(e.target.value)}
                                        required
                                    >
                                        <option value="">— pick an agent —</option>
                                        {agents
                                            .filter((a) => a.is_active && a.role !== 'admin')
                                            .map((a) => (
                                                <option key={a.id} value={a.id}>
                                                    {a.full_name || a.email} ({a.role})
                                                </option>
                                            ))}
                                    </select>
                                </label>
                                <label className="form-group pd-notes-group">
                                    <span className="pd-label">Notes (optional)</span>
                                    <input
                                        type="text"
                                        value={pdNotes}
                                        onChange={(e) => setPdNotes(e.target.value)}
                                        placeholder="Brief — what's this list for?"
                                    />
                                </label>
                                <label className="form-group pd-file-group">
                                    <span className="pd-label">CSV file</span>
                                    <input
                                        type="file"
                                        accept=".csv,text/csv"
                                        onChange={(e) => setPdFile(e.target.files?.[0] || null)}
                                        required
                                    />
                                </label>
                                <button
                                    type="submit"
                                    className="btn-primary pd-submit"
                                    disabled={pdBusy || !pdFile || !pdName.trim() || !pdAssignTo}
                                >
                                    {pdBusy ? 'Uploading…' : <><Upload {...ICON_DEFAULTS} size={14} /> Upload &amp; assign</>}
                                </button>
                            </form>
                            {pdError && (
                                <div className="login-error" style={{ marginTop: 10 }}>
                                    <AlertTriangle {...ICON_DEFAULTS} size={14} /> {pdError}
                                </div>
                            )}
                        </div>

                        <div className="support-card">
                            <span className="support-label">Existing assigned lists ({assignedLists.length})</span>
                            <table className="leads-table" style={{ marginTop: 10 }}>
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Assigned to</th>
                                        <th>Leads</th>
                                        <th>Created</th>
                                        <th>Notes</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {assignedLists.map((l) => (
                                        <tr key={l.id}>
                                            <td><strong>{l.name}</strong></td>
                                            <td>
                                                {l.agent_name ? (
                                                    <span className="pd-pill">
                                                        <Users {...ICON_DEFAULTS} size={11} /> {l.agent_name}
                                                    </span>
                                                ) : (
                                                    <em style={{ color: 'var(--text-muted)', fontSize: 12 }}>everyone (legacy)</em>
                                                )}
                                            </td>
                                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>{l.lead_count}</td>
                                            <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                                {new Date(l.created_at).toLocaleDateString()}
                                            </td>
                                            <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                                {l.notes || '—'}
                                            </td>
                                            <td>
                                                <button
                                                    className="btn-icon-only"
                                                    onClick={() => deleteAssignedList(l.id)}
                                                    aria-label={`Delete ${l.name}`}
                                                >
                                                    <Trash2 {...ICON_DEFAULTS} size={14} />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {assignedLists.length === 0 && (
                                        <tr>
                                            <td colSpan={6} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>
                                                No lists uploaded yet.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Call Card Customization */}
                {activeSection === 'callcard' && (
                    <div className="leads-page">
                        <div className="leads-toolbar">
                            <h2 style={{ flex: 1, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <LayoutGrid {...ICON_DEFAULTS} size={18} /> Call Card Layout
                            </h2>
                            <button className="btn-secondary" onClick={resetCardConfig}>
                                <RotateCcw {...ICON_DEFAULTS} /> Reset
                            </button>
                            <button className="btn-primary" onClick={saveCardConfig}>
                                {cardSaved
                                    ? <><Check {...ICON_DEFAULTS} /> Saved</>
                                    : <><Save {...ICON_DEFAULTS} /> Save</>}
                            </button>
                        </div>

                        <div className="pd-warning" style={{ marginBottom: 16 }}>
                            Pick which lead fields show on the agent&apos;s call popup, and the order
                            they appear in. Fields come from the headers of the CSVs you&apos;ve
                            uploaded — upload a new CSV to make more options available here.
                            Saved settings apply to both the regular Dialer and the Power Dialer.
                        </div>

                        {cardConfig.length === 0 ? (
                            <div className="cc-empty">
                                No CSV columns detected yet. Upload a leads CSV from the dialer
                                page to populate this list.
                            </div>
                        ) : (
                            <div className="cc-config-list">
                                {cardConfig.map((field, idx) => (
                                    <div
                                        key={field.key}
                                        className={`cc-config-row ${!field.enabled ? 'is-disabled' : ''}`}
                                    >
                                        <span className="cc-config-icon">{iconForField(field.key)}</span>
                                        <div className="cc-config-name">
                                            <strong>{labelForField(field.key)}</strong>
                                            <span className="cc-config-key">{field.key}</span>
                                        </div>
                                        <div className="cc-config-actions">
                                            <button
                                                className="cc-arrow-btn"
                                                onClick={() => moveCardField(idx, -1)}
                                                disabled={idx === 0}
                                                title="Move up"
                                                aria-label="Move up"
                                            ><ChevronUp {...ICON_DEFAULTS} size={14} /></button>
                                            <button
                                                className="cc-arrow-btn"
                                                onClick={() => moveCardField(idx, 1)}
                                                disabled={idx === cardConfig.length - 1}
                                                title="Move down"
                                                aria-label="Move down"
                                            ><ChevronDown {...ICON_DEFAULTS} size={14} /></button>
                                            <input
                                                type="checkbox"
                                                className="cc-toggle"
                                                checked={field.enabled}
                                                onChange={() => toggleCardField(idx)}
                                                title={field.enabled ? 'Disable field' : 'Enable field'}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Live preview of what an agent will see */}
                        {cardConfig.some((f) => f.enabled) && (
                            <div className="cc-preview">
                                <h4>Preview (sample lead)</h4>
                                <div className="cc-preview-fields">
                                    {cardConfig
                                        .filter((f) => f.enabled)
                                        .map((f) => (
                                            <div key={f.key} className="cc-preview-field">
                                                <span>{iconForField(f.key)}</span>
                                                <span><strong>{labelForField(f.key)}:</strong> sample value</span>
                                                <span className="cc-preview-key">{f.key}</span>
                                            </div>
                                        ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div style={{ textAlign: 'center', marginTop: 24, color: 'var(--text-muted)', fontSize: 12 }}>
                    Logged in as: {profile?.email} ({profile?.role})
                </div>

                {listenSuccess && (
                    <div className="app-toast">
                        <Check {...ICON_DEFAULTS} size={14} /> {listenSuccess}
                    </div>
                )}
            </main>

            {/* ── Listen-in modal ── */}
            {listenTarget && (
                <div className="app-modal-backdrop" onClick={() => setListenTarget(null)}>
                    <div className="app-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="app-modal-head">
                            <h3><Mic {...ICON_DEFAULTS} size={16} /> Listen to live call</h3>
                            <button className="app-modal-close" onClick={() => setListenTarget(null)} aria-label="Close">
                                <X {...ICON_DEFAULTS} size={14} />
                            </button>
                        </div>
                        <div className="app-modal-body">
                            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 12px' }}>
                                You&rsquo;ll be added to <strong>{listenTarget.agent_name}</strong>&rsquo;s
                                call <strong>muted</strong> — you can hear both sides, but neither side hears you.
                                We&rsquo;ll call your phone; pick up to listen.
                            </p>
                            <label className="form-group">
                                <span style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.05em' }}>
                                    Your phone number
                                </span>
                                <input
                                    type="tel"
                                    placeholder="+91…"
                                    value={listenPhone}
                                    onChange={(e) => setListenPhone(e.target.value)}
                                    autoFocus
                                />
                            </label>
                            {listenError && (
                                <div className="login-error" style={{ marginTop: 10 }}>
                                    <AlertTriangle {...ICON_DEFAULTS} size={14} /> {listenError}
                                </div>
                            )}
                        </div>
                        <div className="app-modal-actions">
                            <button className="btn-secondary" onClick={() => setListenTarget(null)} disabled={listenBusy}>
                                Cancel
                            </button>
                            <button
                                className="btn-primary"
                                onClick={startListen}
                                disabled={listenBusy || !listenPhone.trim()}
                            >
                                {listenBusy ? 'Ringing…' : 'Ring my phone'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
