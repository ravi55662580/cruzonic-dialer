'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Dialer from '@/components/Dialer';
import type { DialerHandle } from '@/components/Dialer';
import PowerDialer from '@/components/PowerDialer';
import ThemeToggle from '@/components/ThemeToggle';
import LiveCoach from '@/components/LiveCoach';
import { useAuth } from '@/components/AuthProvider';
import { rememberColumns } from '@/lib/callCardConfig';
import { formatPhone, formatDuration as fmtDur } from '@/lib/format';
import { recordingProxyUrl } from '@/lib/recordings';
import CallLogFilters, {
    EMPTY_FILTER,
    matchesFilter,
    type CallLogFilterState,
} from '@/components/CallLogFilters';
import {
    Phone, PhoneCall, Zap, Users, ListChecks, Clock,
    Settings, LogOut, Upload, Trash2, X,
    PhoneIncoming, PhoneOutgoing, Check,
    ICON_DEFAULTS,
} from '@/components/Icon';

interface Lead {
    id: string;
    phone: string;
    firstName: string;
    lastName: string;
    company: string;
    email?: string;
    city?: string;
    state?: string;
    custom1?: string;
    custom2?: string;
    custom3?: string;
    status: string;
    lastCalledAt?: string;
    /**
     * Every column from the original CSV, keyed by lowercase header.
     * Lets the call card render arbitrary admin-configured fields without
     * being limited to the predefined ones above.
     */
    extra?: Record<string, string>;
}

interface LeadList {
    id: string;
    name: string;
    leads: Lead[];
    createdAt: string;
    /** True when this list was uploaded by an admin and assigned to me.
     *  Local CSV uploads are tagged false. */
    assignedByAdmin?: boolean;
    notes?: string;
}

interface CallLog {
    id: string;
    number: string;
    direction: string;
    duration: number;
    disposition: string;
    /** Human-readable timestamp (locale string). For display only. */
    timestamp: string;
    /** ISO timestamp from the DB (or generated when logging locally) —
     *  required so the date filter has something to compare against. */
    created_at: string;
    recording_url?: string;
    notes?: string;
    agent_name?: string;
}

export default function Dashboard() {
    const { user, profile, loading: authLoading, isAdmin, signOut } = useAuth();
    const router = useRouter();
    // Role + outbound number to render the small badge next to the user button.
    // Resolved server-side from env vars + the profile row.
    const [whoami, setWhoami] = useState<{ role: string | null; outboundNumber: string } | null>(null);
    // Initialize empty on both server + client to avoid hydration mismatch.
    // The real lists are loaded from localStorage in an effect below.
    const [leadLists, setLeadLists] = useState<LeadList[]>([]);
    // Tracks whether we've finished the initial localStorage hydration, so the
    // persist effect doesn't clobber saved data with the empty initial value.
    const [leadListsHydrated, setLeadListsHydrated] = useState(false);
    const [callLogs, setCallLogs] = useState<CallLog[]>([]);
    const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
    const [activeTab, setActiveTab] = useState<'dialer' | 'power' | 'leads' | 'logs' | 'callbacks'>('dialer');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedListId, setSelectedListId] = useState<string>('');
    const lastDialedNumberRef = useRef('');
    const dialerRef = useRef<DialerHandle>(null);
    const [dialerStatus, setDialerStatus] = useState('offline');
    // Active Twilio Call SID — set when a call connects, cleared when it ends.
    // Drives the LiveCoach transcript subscription.
    const [activeCallSid, setActiveCallSid] = useState<string | null>(null);
    /** Filter state for the Call Logs tab. */
    const [logFilter, setLogFilter] = useState<CallLogFilterState>(EMPTY_FILTER);
    // Most recently ENDED call SID. When set (and activeCallSid is null), the
    // LiveCoach panel switches to its "Call wrap-up" view and kicks off the
    // post-call summary.
    const [wrapUpSid, setWrapUpSid] = useState<string | null>(null);
    // Customer's remote audio stream — populated when a call is accepted.
    // Drives LiveCoach's in-browser Whisper transcription of the customer
    // side in browser-STT mode.
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [callbacks, setCallbacks] = useState<{ id: string; phone: string; lead_name: string; scheduled_at: string; notes: string; status: string }[]>([]);
    // CSV upload UI state — replaces native prompt() and alert(), which Chrome
    // and Firefox sometimes auto-dismiss in dev / hosted iframe contexts.
    const [pendingUpload, setPendingUpload] = useState<{ file: File; defaultName: string } | null>(null);
    const [pendingName, setPendingName] = useState('');
    const [uploadBusy, setUploadBusy] = useState(false);
    /**
     * Toast banner. Optional `action` adds a clickable button (e.g. "Undo").
     * Set `duration` to 0 to disable auto-dismiss.
     */
    const [toast, setToast] = useState<{
        kind: 'error' | 'success' | 'info';
        text: string;
        action?: { label: string; onClick: () => void };
        duration?: number;
    } | null>(null);
    // Delete-list confirmation — replaces native confirm() for the same reason.
    const [pendingDelete, setPendingDelete] = useState<LeadList | null>(null);

    // Auto-clear toast (default 4s, or `toast.duration` ms; 0 = sticky).
    useEffect(() => {
        if (!toast) return;
        const ms = toast.duration ?? 4000;
        if (ms === 0) return;
        const t = setTimeout(() => setToast(null), ms);
        return () => clearTimeout(t);
    }, [toast]);

    // Auth guard — redirect to login if not signed in
    useEffect(() => {
        if (!authLoading && !user) {
            router.push('/login');
        }
    }, [authLoading, user, router]);

    // One-time client-side hydration of lead lists from localStorage.
    // Done in an effect (not in useState init) so SSR + initial CSR markup
    // match. Wrapped in try/catch because corrupt JSON would otherwise crash
    // the whole dashboard.
    useEffect(() => {
        try {
            const saved = localStorage.getItem('cruzonic_lead_lists');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) setLeadLists(parsed);
            }
        } catch (err) {
            console.warn('Failed to load lead lists from localStorage:', err);
        } finally {
            setLeadListsHydrated(true);
        }
    }, []);

    // Load call logs from database (per-agent)
    useEffect(() => {
        if (!profile) return;
        const fetchLogs = async () => {
            try {
                const agentEmail = profile.email;
                const res = await fetch(`/api/call-logs?agent_id=${encodeURIComponent(agentEmail)}`);
                const data = await res.json();
                if (data.logs && data.logs.length > 0) {
                    const mapped = data.logs.map((log: { id: string; number: string; direction: string; duration: number; disposition: string; created_at: string; recording_url?: string; notes?: string; agent_name?: string }) => ({
                        id: log.id,
                        number: log.number,
                        direction: log.direction,
                        duration: log.duration,
                        disposition: log.disposition,
                        timestamp: new Date(log.created_at).toLocaleString(),
                        created_at: log.created_at,
                        recording_url: log.recording_url || undefined,
                        notes: log.notes,
                        agent_name: log.agent_name,
                    }));
                    setCallLogs(mapped);
                }
            } catch {
                const saved = localStorage.getItem('cruzonic_call_logs');
                if (saved) setCallLogs(JSON.parse(saved));
            }
        };
        fetchLogs();
    }, [profile]);

    // Fetch role + outbound number for the badge.
    useEffect(() => {
        if (!profile?.email) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/whoami?email=${encodeURIComponent(profile.email)}`);
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled) setWhoami({ role: data.role, outboundNumber: data.outboundNumber });
            } catch { /* silent — badge just won't show */ }
        })();
        return () => { cancelled = true; };
    }, [profile?.email]);

    // Fetch callbacks from DB
    useEffect(() => {
        if (!profile) return;
        const fetchCallbacks = async () => {
            try {
                const res = await fetch(`/api/callbacks?agent_id=${encodeURIComponent(profile.id || '')}`);
                const json = await res.json();
                if (json.callbacks) setCallbacks(json.callbacks);
            } catch { }
        };
        fetchCallbacks();
    }, [profile]);

    // Fetch admin-assigned Power Dial lists for THIS agent and merge them in.
    // Each assigned list shows up alongside their local CSV uploads but is
    // tagged so the UI can mark it "Assigned by admin". Re-fetch when the
    // hydration step finishes so we don't race the localStorage restore.
    useEffect(() => {
        if (!profile?.id || !leadListsHydrated) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(
                    `/api/lead-lists?agent_id=${encodeURIComponent(profile.id)}`,
                );
                const data = await res.json();
                const lists = Array.isArray(data.lists) ? data.lists : [];
                if (!lists.length) return;

                // Pull leads for every assigned list in parallel. Cheap because
                // RLS already filters at the DB and these are small lists.
                const enriched = await Promise.all(
                    lists.map(async (l: { id: number; name: string; notes?: string; created_at: string; lead_count: number }) => {
                        try {
                            const r = await fetch(`/api/lead-lists/leads?list_id=${l.id}`);
                            const j = await r.json();
                            const leads: Lead[] = (j.leads || []).map((row: Record<string, unknown>) => ({
                                id: `db-${row.id}`,
                                phone: (row.phone || '') as string,
                                firstName: (row.first_name || '') as string,
                                lastName: (row.last_name || '') as string,
                                company: (row.company || '') as string,
                                email: (row.email || '') as string,
                                city: (row.city || '') as string,
                                state: (row.state || '') as string,
                                custom1: (row.custom1 || '') as string,
                                custom2: (row.custom2 || '') as string,
                                custom3: (row.custom3 || '') as string,
                                extra: (row.extra && typeof row.extra === 'object')
                                    ? row.extra as Record<string, string>
                                    : {},
                            }));
                            return {
                                id: `db-${l.id}`,
                                name: l.name,
                                leads,
                                createdAt: l.created_at,
                                assignedByAdmin: true,
                                notes: l.notes || undefined,
                            } as LeadList;
                        } catch {
                            return null;
                        }
                    }),
                );

                if (cancelled) return;
                const valid = enriched.filter((x): x is LeadList => x !== null);
                if (!valid.length) return;

                setLeadLists((prev) => {
                    // Drop any prior DB lists, then re-attach the fresh batch.
                    // Local CSV uploads (id without "db-" prefix) are preserved.
                    const local = prev.filter((l) => !l.id.startsWith('db-'));
                    return [...local, ...valid];
                });
            } catch (err) {
                console.warn('fetch assigned lists failed', err);
            }
        })();
        return () => { cancelled = true; };
    }, [profile?.id, leadListsHydrated]);

    // Persist lead lists to localStorage. Guarded by `leadListsHydrated` so
    // we don't write the empty initial state back over saved data on first
    // render — that would silently delete the user's lists on every reload.
    // Admin-assigned lists (id prefix "db-") aren't persisted — they're
    // always re-fetched from the API so role re-assignments take effect.
    useEffect(() => {
        if (!leadListsHydrated) return;
        try {
            const localOnly = leadLists.filter((l) => !l.id.startsWith('db-'));
            localStorage.setItem('cruzonic_lead_lists', JSON.stringify(localOnly));
        } catch (err) {
            console.warn('Failed to persist lead lists:', err);
        }
    }, [leadLists, leadListsHydrated]);

    // Also persist call logs to localStorage as backup
    useEffect(() => {
        if (callLogs.length > 0) {
            localStorage.setItem('cruzonic_call_logs', JSON.stringify(callLogs));
        }
    }, [callLogs]);

    // Handle CSV Upload (max 10MB, max 5000 leads)
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const MAX_LEADS = 5000;

    // Parse a single CSV line, respecting double-quoted fields that may contain
    // commas or escaped quotes ("" → "). The previous naive `line.split(',')`
    // mangled any address or company name with a comma in it.
    const parseCsvLine = (line: string): string[] => {
        const out: string[] = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (line[i + 1] === '"') { cur += '"'; i++; }
                    else { inQuotes = false; }
                } else {
                    cur += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                out.push(cur);
                cur = '';
            } else {
                cur += ch;
            }
        }
        out.push(cur);
        return out.map(v => v.trim());
    };

    // Step 1: file picked → validate size + open the rename modal.
    // Native prompt()/alert() got replaced because some browsers auto-dismiss
    // them when called from a file-input change handler.
    const handleCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        // Reset the input immediately so the user can re-upload the same file
        // later if they cancel the modal.
        event.target.value = '';
        if (!file) return;

        if (file.size > MAX_FILE_SIZE) {
            setToast({
                kind: 'error',
                text: `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max is ${MAX_FILE_SIZE / 1024 / 1024}MB — split into smaller batches.`,
            });
            return;
        }

        const defaultName = file.name.replace(/\.csv$/i, '');
        setPendingUpload({ file, defaultName });
        setPendingName(defaultName);
    };

    // Step 2: user confirms the name → parse + insert.
    const confirmCsvUpload = () => {
        if (!pendingUpload) return;
        const trimmedName = pendingName.trim();
        if (!trimmedName) {
            setToast({ kind: 'error', text: 'Please enter a name for this list.' });
            return;
        }

        setUploadBusy(true);
        const { file } = pendingUpload;
        const reader = new FileReader();

        reader.onerror = () => {
            setUploadBusy(false);
            setToast({ kind: 'error', text: 'Failed to read CSV file.' });
        };

        reader.onload = (e) => {
            try {
                const csv = (e.target?.result as string) || '';
                const lines = csv.replace(/\r\n?/g, '\n').split('\n');

                if (lines.length === 0 || !lines[0].trim()) {
                    setToast({ kind: 'error', text: 'CSV appears to be empty — no header row found.' });
                    return;
                }

                const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
                const dataLines = lines.slice(1).filter((line) => line.trim());

                if (dataLines.length === 0) {
                    setToast({ kind: 'error', text: 'CSV has a header row but no data rows.' });
                    return;
                }

                if (dataLines.length > MAX_LEADS) {
                    setToast({
                        kind: 'error',
                        text: `Too many leads (${dataLines.length.toLocaleString()}). Max ${MAX_LEADS.toLocaleString()} per upload — split into batches.`,
                    });
                    return;
                }

                // Make every CSV column visible to the admin's call-card editor.
                rememberColumns(headers);

                const newLeads: Lead[] = dataLines.map((line, idx) => {
                    const values = parseCsvLine(line);
                    const getValue = (key: string) => {
                        const index = headers.indexOf(key);
                        return index >= 0 ? (values[index] ?? '') : '';
                    };

                    const extra: Record<string, string> = {};
                    headers.forEach((h, i) => {
                        if (h) extra[h] = values[i] ?? '';
                    });

                    return {
                        id: `lead-${Date.now()}-${idx}`,
                        phone: getValue('phone_number') || getValue('phone') || values[0] || '',
                        firstName: getValue('first_name') || getValue('firstname') || '',
                        lastName: getValue('last_name') || getValue('lastname') || '',
                        company: getValue('company') || '',
                        email: getValue('email') || '',
                        city: getValue('city') || '',
                        state: getValue('state') || '',
                        custom1: getValue('mc_number') || getValue('custom_field_1') || '',
                        custom2: getValue('fleet_size') || getValue('custom_field_2') || '',
                        custom3: getValue('current_eld') || getValue('custom_field_3') || '',
                        status: 'new',
                        extra,
                    };
                });

                const newList: LeadList = {
                    id: `list-${Date.now()}`,
                    name: trimmedName,
                    leads: newLeads,
                    createdAt: new Date().toISOString(),
                };

                setLeadLists((prev) => [...prev, newList]);
                setToast({
                    kind: 'success',
                    text: `Created list “${trimmedName}” with ${newLeads.length.toLocaleString()} leads.`,
                });
                setPendingUpload(null);
                setPendingName('');
            } catch (err) {
                console.error('CSV parse error:', err);
                setToast({ kind: 'error', text: 'Failed to parse CSV — check the file format.' });
            } finally {
                setUploadBusy(false);
            }
        };

        reader.readAsText(file);
    };

    const cancelCsvUpload = () => {
        setPendingUpload(null);
        setPendingName('');
    };

    // Call a lead
    const callLead = (lead: Lead) => {
        setSelectedLead(lead);
        setActiveTab('dialer');
    };

    // Log a call — saves to database AND local state
    const logCall = async (
        number: string,
        duration: number,
        disposition: string,
        callSid?: string,
        direction: 'inbound' | 'outbound' = 'outbound',
    ) => {
        const agentName = profile?.full_name || profile?.email || 'Unknown';
        const agentId = profile?.email || 'unknown';
        const log: CallLog = {
            id: `log-${Date.now()}`,
            number,
            direction,
            duration,
            disposition,
            timestamp: new Date().toLocaleString(),
            created_at: new Date().toISOString(),
        };
        setCallLogs((prev) => [log, ...prev]);

        // Save to database with agent info and call SID
        try {
            await fetch('/api/call-logs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    number,
                    direction,
                    duration,
                    disposition,
                    agent_id: agentId,
                    agent_name: agentName,
                    call_sid: callSid || null,
                }),
            });
        } catch (err) {
            console.error('Failed to save call log to database:', err);
        }
    };

    // Get all leads across lists (flat)
    const allLeads = leadLists.flatMap(list => list.leads);
    const totalLeadCount = allLeads.length;

    // Get selected list's leads for power dialer
    const selectedList = leadLists.find(l => l.id === selectedListId) || null;

    // Filter leads by search
    const filteredLeads = allLeads.filter((lead: Lead) => {
        const q = searchQuery.toLowerCase();
        return (
            lead.firstName.toLowerCase().includes(q) ||
            lead.lastName.toLowerCase().includes(q) ||
            lead.company.toLowerCase().includes(q) ||
            lead.phone.includes(q)
        );
    });

    const formatDuration = fmtDur;

    // Update lead status (from PowerDialer)
    const updateLeadStatus = useCallback((leadId: string, status: string) => {
        setLeadLists(prev => prev.map(list => ({
            ...list,
            leads: list.leads.map((lead: Lead) =>
                lead.id === leadId ? { ...lead, status, lastCalledAt: new Date().toISOString() } : lead
            )
        })));
        // Also update in DB
        fetch('/api/leads', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: leadId, status, last_called_at: new Date().toISOString() }),
        }).catch(() => { });
    }, []);

    // Power Dialer call log handler
    const handlePowerDialerLog = useCallback(async (number: string, duration: number, disposition: string, callSid: string, notes: string) => {
        const agentName = profile?.full_name || profile?.email || 'Unknown';
        const agentId = profile?.email || 'unknown';
        const log: CallLog = {
            id: `log-${Date.now()}`,
            number,
            direction: 'outbound',
            duration,
            disposition,
            timestamp: new Date().toLocaleString(),
            created_at: new Date().toISOString(),
            notes: notes || '',
        };
        setCallLogs(prev => [log, ...prev]);

        try {
            await fetch('/api/call-logs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    number,
                    direction: 'outbound',
                    duration,
                    disposition,
                    agent_id: agentId,
                    agent_name: agentName,
                    call_sid: callSid || null,
                    notes: notes || '',
                }),
            });
        } catch (err) {
            console.error('Failed to save call log:', err);
        }
    }, [profile]);

    if (authLoading) {
        return (
            <div className="login-page">
                <div className="login-card"><p style={{ textAlign: 'center', padding: '40px' }}><span className="spinner"></span> Loading...</p></div>
            </div>
        );
    }

    if (!user) return null;

    return (
        <div className="dashboard">
            {/* Toast — fades after 4 seconds (see useEffect above) */}
            {toast && (
                <div
                    className={`app-toast ${toast.kind === 'success' ? 'success-banner' : toast.kind === 'info' ? 'info-banner' : 'error-banner'}`}
                    role="status"
                >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {toast.kind === 'success' ? <Check {...ICON_DEFAULTS} size={14} /> : null}
                        {toast.text}
                    </span>
                    {toast.action && (
                        <button
                            type="button"
                            className="app-toast-action"
                            onClick={() => { toast.action?.onClick(); setToast(null); }}
                        >
                            {toast.action.label}
                        </button>
                    )}
                    <button
                        type="button"
                        className="app-toast-dismiss"
                        onClick={() => setToast(null)}
                        aria-label="Dismiss"
                    ><X {...ICON_DEFAULTS} size={14} /></button>
                </div>
            )}

            {/* CSV upload modal — replaces window.prompt() */}
            {pendingUpload && (
                <div className="app-modal-backdrop" onClick={cancelCsvUpload}>
                    <div className="app-modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 style={{ marginBottom: 6 }}>📤 Name this lead list</h3>
                        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                            From: <strong>{pendingUpload.file.name}</strong> ·{' '}
                            {(pendingUpload.file.size / 1024).toFixed(1)} KB
                        </p>
                        <div className="form-group" style={{ marginBottom: 16 }}>
                            <label htmlFor="list-name">List name</label>
                            <input
                                id="list-name"
                                type="text"
                                value={pendingName}
                                onChange={(e) => setPendingName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') confirmCsvUpload();
                                    if (e.key === 'Escape') cancelCsvUpload();
                                }}
                                autoFocus
                                disabled={uploadBusy}
                            />
                        </div>
                        <div className="app-modal-actions">
                            <button
                                type="button"
                                className="btn-secondary"
                                onClick={cancelCsvUpload}
                                disabled={uploadBusy}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="btn-primary"
                                onClick={confirmCsvUpload}
                                disabled={uploadBusy || !pendingName.trim()}
                            >
                                {uploadBusy ? (<><span className="spinner"></span> Importing...</>) : 'Create List'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete-list confirmation modal — replaces window.confirm() */}
            {pendingDelete && (
                <div className="app-modal-backdrop" onClick={() => setPendingDelete(null)}>
                    <div className="app-modal-card" onClick={(e) => e.stopPropagation()}>
                        <h3 style={{ marginBottom: 6 }}>🗑️ Delete lead list?</h3>
                        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
                            This will remove <strong>“{pendingDelete.name}”</strong> ({pendingDelete.leads.length} leads) from this browser.
                        </p>
                        <div className="app-modal-actions">
                            <button
                                type="button"
                                className="btn-secondary"
                                onClick={() => setPendingDelete(null)}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="btn-danger"
                                onClick={() => {
                                    // Snapshot the deleted list so the Undo button can restore it.
                                    const snapshot = pendingDelete;
                                    const wasSelected = selectedListId === snapshot.id;
                                    setLeadLists((prev) => prev.filter((l) => l.id !== snapshot.id));
                                    if (wasSelected) setSelectedListId('');
                                    setPendingDelete(null);
                                    setToast({
                                        kind: 'info',
                                        text: `Deleted “${snapshot.name}”.`,
                                        duration: 6000,
                                        action: {
                                            label: 'Undo',
                                            onClick: () => {
                                                setLeadLists((prev) => [...prev, snapshot]);
                                                if (wasSelected) setSelectedListId(snapshot.id);
                                            },
                                        },
                                    });
                                }}
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <header className="dashboard-header">
                <div className="logo">
                    <span className="logo-icon"><PhoneCall {...ICON_DEFAULTS} size={18} /></span>
                    <h1>Cruzonic Dialer</h1>
                    <ThemeToggle />
                </div>
                <nav className="nav-tabs">
                    <button
                        className={`nav-tab ${activeTab === 'dialer' ? 'active' : ''}`}
                        onClick={() => setActiveTab('dialer')}
                    >
                        <Phone {...ICON_DEFAULTS} /> Dialer
                    </button>
                    <button
                        className={`nav-tab ${activeTab === 'power' ? 'active' : ''}`}
                        onClick={() => setActiveTab('power')}
                    >
                        <Zap {...ICON_DEFAULTS} /> Power Dialer
                    </button>
                    <button
                        className={`nav-tab ${activeTab === 'leads' ? 'active' : ''}`}
                        onClick={() => setActiveTab('leads')}
                    >
                        <Users {...ICON_DEFAULTS} /> Leads ({totalLeadCount})
                    </button>
                    <button
                        className={`nav-tab ${activeTab === 'logs' ? 'active' : ''}`}
                        onClick={() => setActiveTab('logs')}
                    >
                        <ListChecks {...ICON_DEFAULTS} /> Call Logs ({callLogs.length})
                    </button>
                    <button
                        className={`nav-tab ${activeTab === 'callbacks' ? 'active' : ''}`}
                        onClick={() => setActiveTab('callbacks')}
                    >
                        <Clock {...ICON_DEFAULTS} /> Callbacks ({callbacks.length})
                    </button>
                    {isAdmin && (
                        <button className="nav-tab" onClick={() => router.push('/admin')}>
                            <Settings {...ICON_DEFAULTS} /> Admin
                        </button>
                    )}
                    {whoami?.role && whoami.role !== 'admin' && (
                        <span
                            className={`role-pill role-${whoami.role}`}
                            title={`Outbound calls go out from ${whoami.outboundNumber}`}
                        >
                            <span className="role-pill-role">{whoami.role}</span>
                            <span className="role-pill-num">{formatPhone(whoami.outboundNumber)}</span>
                        </span>
                    )}
                    <button className="nav-tab nav-tab-user" onClick={signOut}>
                        <LogOut {...ICON_DEFAULTS} /> {profile?.full_name || profile?.email || 'Logout'}
                    </button>
                </nav>
            </header>

            {/* Main Content */}
            <main className="dashboard-main">
                {/* Dialer Tab */}
                {activeTab === 'dialer' && (
                    <div className="dialer-page">
                        <div className="dialer-panel">
                            <Dialer
                                ref={dialerRef}
                                agentId={profile?.id || ''}
                                // Twilio Voice SDK identity = email. The inbound
                                // voice route fans out via `<Dial><Client>email</Client>`,
                                // so the Device must register with the same string.
                                // Without this, inbound sales calls find no client
                                // registered as the email, fail the dial, and fall
                                // through to a 17-minute voicemail cycle.
                                twilioIdentity={profile?.email || ''}
                                leadInfo={
                                    selectedLead
                                        ? {
                                            name: `${selectedLead.firstName} ${selectedLead.lastName}`,
                                            company: selectedLead.company,
                                            phone: selectedLead.phone,
                                            email: selectedLead.email,
                                            city: selectedLead.city,
                                            state: selectedLead.state,
                                            custom1: selectedLead.custom1,
                                            custom2: selectedLead.custom2,
                                            custom3: selectedLead.custom3,
                                            extra: selectedLead.extra,
                                        }
                                        : null
                                }
                                onStatusChange={setDialerStatus}
                                onCallSidChange={(sid) => {
                                    if (sid) {
                                        // New call starting — clear any previous wrap-up.
                                        setActiveCallSid(sid);
                                        setWrapUpSid(null);
                                    } else {
                                        // Call ended — promote activeCallSid into wrapUpSid so
                                        // the panel triggers the summary fetch.
                                        setActiveCallSid((prev) => {
                                            if (prev) setWrapUpSid(prev);
                                            return null;
                                        });
                                    }
                                }}
                                onRemoteStreamChange={setRemoteStream}
                                onCallStart={(num) => {
                                    lastDialedNumberRef.current = num;
                                    console.log('Call started:', num);
                                }}
                                onCallEnd={(dur, callSid, disposition, direction, number) => {
                                    // For inbound calls, Dialer hands us the caller's phone
                                    // explicitly because there's no "last dialed number" for it.
                                    const dir = direction || 'outbound';
                                    const numberToLog = dir === 'inbound'
                                        ? (number || '')
                                        : (lastDialedNumberRef.current || selectedLead?.phone || '');
                                    logCall(
                                        numberToLog,
                                        dur,
                                        disposition || 'completed',
                                        callSid,
                                        dir,
                                    );
                                }}
                            />
                        </div>

                        {/* Live transcript / coaching panel — fills the middle column.
                            Keyed by callSid so each call gets a fresh component instance
                            (avoids stale state from the previous call). */}
                        <LiveCoach
                            // Key: active call when live, wrap-up SID after the call, else "idle".
                            // Remounting on transition cleanly resets internal state.
                            key={activeCallSid || (wrapUpSid ? `wrap-${wrapUpSid}` : 'idle')}
                            callSid={activeCallSid}
                            wrapUpCallSid={wrapUpSid}
                            onDismissWrapUp={() => setWrapUpSid(null)}
                            customerStream={remoteStream}
                            lead={
                                selectedLead
                                    ? {
                                        name: `${selectedLead.firstName} ${selectedLead.lastName}`.trim(),
                                        company: selectedLead.company,
                                        extra: selectedLead.extra,
                                    }
                                    : null
                            }
                        />

                        {/* Quick Lead List */}
                        {allLeads.length > 0 && (
                            <div className="quick-leads">
                                <h3>Quick Dial</h3>
                                <div className="quick-lead-list">
                                    {allLeads.slice(0, 10).map((lead: Lead) => (
                                        <button
                                            key={lead.id}
                                            className={`quick-lead-item ${selectedLead?.id === lead.id ? 'selected' : ''}`}
                                            onClick={() => callLead(lead)}
                                        >
                                            <div className="quick-lead-name">
                                                {(lead.firstName || lead.lastName)
                                                    ? `${lead.firstName} ${lead.lastName}`.trim()
                                                    : formatPhone(lead.phone)}
                                            </div>
                                            <div className="quick-lead-company">
                                                {lead.company || formatPhone(lead.phone)}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Power Dialer Tab */}
                {activeTab === 'power' && (
                    <div className="dialer-page">
                        <div className="dialer-panel" style={{ display: dialerStatus === 'offline' ? 'block' : 'none' }}>
                            <Dialer
                                ref={dialerRef}
                                onStatusChange={setDialerStatus}
                                onCallStart={(num) => {
                                    lastDialedNumberRef.current = num;
                                }}
                                onCallEnd={() => {
                                    // Power dialer handles its own logging
                                }}
                            />
                        </div>

                        {/* List Selector */}
                        <div className="pd-list-selector">
                            <label>Select Lead List:</label>
                            <select
                                value={selectedListId}
                                onChange={(e) => setSelectedListId(e.target.value)}
                                className="pd-list-dropdown"
                            >
                                <option value="">-- Choose a list --</option>
                                {leadLists.map(list => (
                                    <option key={list.id} value={list.id}>
                                        {list.name} ({list.leads.length} leads)
                                    </option>
                                ))}
                            </select>
                        </div>

                        {selectedList ? (
                            <PowerDialer
                                leads={selectedList.leads}
                                onLeadUpdate={updateLeadStatus}
                                onCallLog={handlePowerDialerLog}
                                dialerRef={dialerRef}
                                dialerStatus={dialerStatus}
                            />
                        ) : (
                            <div className="pd-empty">
                                <div className="pd-empty-icon">📋</div>
                                <h3>Select a Lead List</h3>
                                <p>Choose a list above to start power dialing, or upload a new CSV in the Leads tab.</p>
                            </div>
                        )}
                    </div>
                )}

                {/* Leads Tab */}
                {activeTab === 'leads' && (
                    <div className="leads-page">
                        <div className="leads-toolbar">
                            <input
                                type="text"
                                placeholder="Search leads..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="search-input"
                            />
                            <label className="btn-upload">
                                <Upload {...ICON_DEFAULTS} /> Upload CSV
                                <input
                                    type="file"
                                    accept=".csv"
                                    onChange={handleCsvUpload}
                                    hidden
                                />
                            </label>
                        </div>

                        {leadLists.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon"><Users {...ICON_DEFAULTS} size={40} /></div>
                                <h3>No lead lists yet</h3>
                                <p>Drop in a CSV — phone numbers and names at minimum. Any extra columns become available in the admin Call Card editor.</p>
                                <label className="btn-primary btn-upload-large">
                                    <Upload {...ICON_DEFAULTS} /> Upload CSV
                                    <input
                                        type="file"
                                        accept=".csv"
                                        onChange={handleCsvUpload}
                                        hidden
                                    />
                                </label>
                            </div>
                        ) : (
                            <>
                                {/* Lead Lists Summary */}
                                <div className="lead-lists-grid">
                                    {leadLists.map(list => {
                                        const newCount = list.leads.filter((l: Lead) => l.status === 'new').length;
                                        const calledCount = list.leads.length - newCount;
                                        return (
                                            <div key={list.id} className={`lead-list-card ${list.assignedByAdmin ? 'lead-list-assigned' : ''}`}>
                                                <div className="lead-list-header">
                                                    <h3>
                                                        {list.name}
                                                        {list.assignedByAdmin && (
                                                            <span className="lead-list-badge" title="Assigned to you by an admin">
                                                                Assigned
                                                            </span>
                                                        )}
                                                    </h3>
                                                    {!list.assignedByAdmin && (
                                                        <button
                                                            className="btn-danger-small"
                                                            onClick={() => setPendingDelete(list)}
                                                            aria-label={`Delete list ${list.name}`}
                                                            title="Delete list"
                                                        >
                                                            <Trash2 {...ICON_DEFAULTS} size={14} />
                                                        </button>
                                                    )}
                                                </div>
                                                {list.assignedByAdmin && list.notes && (
                                                    <p className="lead-list-notes">{list.notes}</p>
                                                )}
                                                <div className="lead-list-stats">
                                                    <span>{list.leads.length} total</span>
                                                    <span className="stat-new">{newCount} new</span>
                                                    <span className="stat-called">{calledCount} called</span>
                                                </div>
                                                <div className="lead-list-date">
                                                    Created: {new Date(list.createdAt).toLocaleDateString()}
                                                </div>
                                                <button
                                                    className="btn-primary btn-power-dial"
                                                    onClick={() => { setSelectedListId(list.id); setActiveTab('power'); }}
                                                >
                                                    <Zap {...ICON_DEFAULTS} /> Power Dial This List
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* All Leads Table */}
                                {searchQuery && (
                                    <div className="leads-table-container" style={{ marginTop: 20 }}>
                                        <h3 style={{ marginBottom: 12, fontSize: 16 }}>Search Results ({filteredLeads.length})</h3>
                                        <table className="leads-table">
                                            <thead>
                                                <tr>
                                                    <th>Name</th>
                                                    <th>Company</th>
                                                    <th>Phone</th>
                                                    <th>City</th>
                                                    <th>Status</th>
                                                    <th>Action</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {filteredLeads.map((lead: Lead) => (
                                                    <tr key={lead.id}>
                                                        <td className="lead-name-cell">
                                                            {lead.firstName} {lead.lastName}
                                                        </td>
                                                        <td>{lead.company}</td>
                                                        <td className="lead-phone-cell">{formatPhone(lead.phone)}</td>
                                                        <td>{lead.city}{lead.state ? `, ${lead.state}` : ''}</td>
                                                        <td>
                                                            <span className={`status-badge status-${lead.status}`}>
                                                                {lead.status}
                                                            </span>
                                                        </td>
                                                        <td>
                                                            <button
                                                                className="btn-call-small"
                                                                onClick={() => callLead(lead)}
                                                            >
                                                                <Phone {...ICON_DEFAULTS} size={13} /> Call
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}

                {/* Call Logs Tab */}
                {activeTab === 'logs' && (() => {
                    const filteredLogs = callLogs.filter((log) => matchesFilter(logFilter, log));
                    const distinctDispositions = Array.from(
                        new Set(callLogs.map((l) => l.disposition).filter(Boolean)),
                    );
                    return (
                        <div className="logs-page">
                            {callLogs.length === 0 ? (
                                <div className="empty-state">
                                    <div className="empty-icon"><ListChecks {...ICON_DEFAULTS} size={40} /></div>
                                    <h3>No call logs yet</h3>
                                    <p>Make your first call from the Dialer or Power Dialer — it&apos;ll show up here with duration, recording, and disposition.</p>
                                    <button className="btn-primary" onClick={() => setActiveTab('dialer')}>
                                        <Phone {...ICON_DEFAULTS} /> Open Dialer
                                    </button>
                                </div>
                            ) : (
                                <>
                                    <CallLogFilters
                                        value={logFilter}
                                        onChange={setLogFilter}
                                        dispositions={distinctDispositions}
                                        showDirection={true}
                                        matchCount={filteredLogs.length}
                                        totalCount={callLogs.length}
                                    />
                                    <div className="logs-table-container">
                                        <table className="leads-table">
                                            <thead>
                                                <tr>
                                                    <th>Time</th>
                                                    <th>Number</th>
                                                    <th>Direction</th>
                                                    <th>Duration</th>
                                                    <th>Disposition</th>
                                                    <th>Recording</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {filteredLogs.map((log) => (
                                                    <tr key={log.id}>
                                                        <td>{log.timestamp}</td>
                                                        <td className="lead-phone-cell">{formatPhone(log.number)}</td>
                                                        <td>
                                                            <span className={`direction-badge ${log.direction}`}>
                                                                {log.direction === 'outbound'
                                                                    ? <PhoneOutgoing {...ICON_DEFAULTS} size={13} />
                                                                    : <PhoneIncoming {...ICON_DEFAULTS} size={13} />}
                                                                {log.direction}
                                                            </span>
                                                        </td>
                                                        <td>{formatDuration(log.duration)}</td>
                                                        <td>
                                                            <span className={`status-badge status-${log.disposition || 'completed'}`}>
                                                                {log.disposition}
                                                            </span>
                                                        </td>
                                                        <td>
                                                            {log.recording_url ? (
                                                                <audio controls preload="none" className="recording-player">
                                                                    <source src={recordingProxyUrl(log.recording_url) || ''} type="audio/mpeg" />
                                                                </audio>
                                                            ) : (
                                                                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                                {filteredLogs.length === 0 && (
                                                    <tr>
                                                        <td colSpan={6} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                                            No logs match these filters
                                                        </td>
                                                    </tr>
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </>
                            )}
                        </div>
                    );
                })()}

                {/* Callbacks Tab */}
                {activeTab === 'callbacks' && (
                    <div className="leads-page">
                        <h2 style={{ fontSize: 18, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Clock {...ICON_DEFAULTS} size={18} /> Scheduled Callbacks
                        </h2>
                        {callbacks.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-icon"><Clock {...ICON_DEFAULTS} size={40} /></div>
                                <h3>No pending callbacks</h3>
                                <p>When you mark a call &ldquo;Callback&rdquo; in the Power Dialer, it&apos;ll appear here with the scheduled time and notes.</p>
                            </div>
                        ) : (
                            <div className="quick-lead-list">
                                {callbacks.map(cb => (
                                    <div key={cb.id} className="quick-lead-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <div style={{ fontWeight: 600 }}>{cb.lead_name || cb.phone}</div>
                                            <div style={{ fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    <Phone {...ICON_DEFAULTS} size={12} /> {formatPhone(cb.phone)}
                                                </span>
                                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    <Clock {...ICON_DEFAULTS} size={12} /> {new Date(cb.scheduled_at).toLocaleString()}
                                                </span>
                                            </div>
                                            {cb.notes && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{cb.notes}</div>}
                                        </div>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button
                                                className="btn-primary"
                                                style={{ padding: '6px 12px', fontSize: 12 }}
                                                onClick={() => {
                                                    setActiveTab('dialer');
                                                    setTimeout(() => dialerRef.current?.makeCall(cb.phone), 500);
                                                }}
                                            >
                                                <Phone {...ICON_DEFAULTS} size={13} /> Call Now
                                            </button>
                                            <button
                                                className="btn-secondary"
                                                style={{ padding: '6px 12px', fontSize: 12 }}
                                                onClick={async () => {
                                                    await fetch('/api/callbacks', {
                                                        method: 'PUT',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({ id: cb.id, status: 'completed' }),
                                                    });
                                                    setCallbacks(prev => prev.filter(c => c.id !== cb.id));
                                                }}
                                            >
                                                <Check {...ICON_DEFAULTS} size={13} /> Done
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </main>
        </div>
    );
}
