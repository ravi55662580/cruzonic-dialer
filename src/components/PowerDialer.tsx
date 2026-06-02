'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { DialerHandle } from './Dialer';
import {
    resolveConfig,
    labelForField,
    iconForField,
    type CallCardField,
} from '@/lib/callCardConfig';
import { formatPhone } from '@/lib/format';
import {
    Zap, Play, Pause, Square, SkipForward, RotateCcw, PhoneOff,
    AlertTriangle, ICON_DEFAULTS,
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
    /** Raw CSV columns kept around for the admin-configurable call card. */
    extra?: Record<string, string>;
}

/** Resolve a call-card field key against a lead, preferring the raw CSV. */
function getLeadValue(lead: Lead, key: string): string {
    const fromExtra = lead.extra?.[key];
    if (fromExtra) return fromExtra;
    switch (key) {
        case 'phone':
        case 'phone_number': return lead.phone || '';
        case 'first_name':
        case 'firstname': return lead.firstName || '';
        case 'last_name':
        case 'lastname': return lead.lastName || '';
        case 'company': return lead.company || '';
        case 'email': return lead.email || '';
        case 'city': return lead.city || '';
        case 'state': return lead.state || '';
        case 'mc_number':
        case 'custom_field_1': return lead.custom1 || '';
        case 'fleet_size':
        case 'custom_field_2': return lead.custom2 || '';
        case 'current_eld':
        case 'custom_field_3': return lead.custom3 || '';
        default: return '';
    }
}

type PowerDialerState = 'idle' | 'dialing' | 'on-call' | 'disposition' | 'countdown' | 'paused' | 'completed';

const DISPOSITIONS = [
    { id: 'interested', label: '✅ Interested', color: '#10b981' },
    { id: 'not_interested', label: '❌ Not Interested', color: '#ef4444' },
    { id: 'callback', label: '📞 Callback', color: '#f59e0b' },
    { id: 'no_answer', label: '📵 No Answer', color: '#6b7280' },
    { id: 'voicemail', label: '📬 Voicemail', color: '#8b5cf6' },
    { id: 'wrong_number', label: '🚫 Wrong Number', color: '#dc2626' },
];

const COUNTDOWN_SECONDS = 5;

interface PowerDialerProps {
    leads: Lead[];
    onLeadUpdate: (leadId: string, status: string) => void;
    onCallLog: (number: string, duration: number, disposition: string, callSid: string, notes: string) => void;
    dialerRef: React.RefObject<DialerHandle | null>;
    dialerStatus: string;
}

export default function PowerDialer({ leads, onLeadUpdate, onCallLog, dialerRef, dialerStatus }: PowerDialerProps) {
    const [state, setState] = useState<PowerDialerState>('idle');
    const [currentIndex, setCurrentIndex] = useState(0);
    const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
    const [totalCalled, setTotalCalled] = useState(0);
    const [callNotes, setCallNotes] = useState('');
    const [dncSkipped, setDncSkipped] = useState(0);
    const [cardConfig, setCardConfig] = useState<CallCardField[]>([]);
    const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const isActiveRef = useRef(false);
    // Snapshot the dial queue at start — doesn't shrink during session
    const dialQueueRef = useRef<Lead[]>([]);
    const [dialQueue, setDialQueue] = useState<Lead[]>([]);
    // Track previous dialer status so we only react to transitions, not every render.
    const prevDialerStatusRef = useRef(dialerStatus);

    // Callable leads for the Start button count (before session starts)
    const callableLeads = leads.filter(l => l.status === 'new' || l.status === 'callback');
    // During a session, use the snapshotted queue; otherwise use callable leads
    const activeQueue = state === 'idle' ? callableLeads : dialQueue;
    const currentLead = activeQueue[currentIndex] || null;

    // Clean up timer on unmount
    useEffect(() => {
        return () => {
            if (countdownRef.current) clearInterval(countdownRef.current);
        };
    }, []);

    // Resolve the admin-configured call-card layout from the columns present in
    // the current lead set. Refreshes when leads change or when an admin edits
    // the config in another tab (storage event).
    useEffect(() => {
        const cols = new Set<string>();
        for (const l of leads) {
            if (l.extra) for (const k of Object.keys(l.extra)) cols.add(k);
        }
        const refresh = () => setCardConfig(resolveConfig(Array.from(cols)));
        refresh();
        const onStorage = (e: StorageEvent) => {
            if (e.key === 'cruzonic_call_card_config' || e.key === 'cruzonic_known_columns') {
                refresh();
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [leads]);

    // Sync our internal state machine to the underlying Dialer's status.
    // We only act on transitions (prev → current) so the effect doesn't churn,
    // and we use the functional `setState` form so we don't need `state` in deps.
    useEffect(() => {
        const prev = prevDialerStatusRef.current;
        prevDialerStatusRef.current = dialerStatus;
        if (prev === dialerStatus) return;

        if (dialerStatus === 'on-call') {
            setState((s) => (s === 'dialing' ? 'on-call' : s));
        } else if (dialerStatus === 'wrap-up' || (prev === 'on-call' && dialerStatus === 'ready')) {
            setState((s) => (s === 'on-call' ? 'disposition' : s));
        }
    }, [dialerStatus]);

    // Refs are intentionally excluded from deps — they're stable identities, and
    // including them trips React Compiler's "may be modified later" warning.
    const dialCurrent = useCallback(async () => {
        const lead = currentLead;
        const dialer = dialerRef.current;
        if (!lead || !dialer) return;

        const status = dialer.getStatus();
        if (status !== 'ready') {
            console.log('Dialer not ready, waiting...', status);
            return;
        }

        setState('dialing');
        try {
            await dialer.makeCall(lead.phone);
        } catch (err) {
            console.error('Power dialer call failed:', err);
            setState('disposition');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentLead]);

    // Start the power dialer — snapshot the queue, filter DNC
    const start = async () => {
        const queue = leads.filter(l => l.status === 'new' || l.status === 'callback');
        if (queue.length === 0) return;

        // Check DNC list
        let filteredQueue = queue;
        let skipped = 0;
        try {
            const phones = queue.map(l => l.phone);
            const res = await fetch('/api/dnc', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phones }),
            });
            const json = await res.json();
            if (json.dnc && json.dnc.length > 0) {
                const dncSet = new Set<string>(json.dnc);
                filteredQueue = queue.filter(l => !dncSet.has(l.phone.replace(/[^+\d]/g, '')));
                skipped = queue.length - filteredQueue.length;
            }
        } catch {
            // DNC check failed, proceed without filtering
        }

        if (filteredQueue.length === 0) {
            alert('All leads in this list are on the Do Not Call list.');
            return;
        }

        dialQueueRef.current = filteredQueue;
        setDialQueue(filteredQueue);
        isActiveRef.current = true;
        setCurrentIndex(0);
        setTotalCalled(0);
        setDncSkipped(skipped);
        setState('dialing');
        // Small delay to let state settle
        setTimeout(() => dialCurrent(), 500);
    };

    // Start countdown, then auto-dial next
    const startCountdown = useCallback(() => {
        setState('countdown');
        setCountdown(COUNTDOWN_SECONDS);
        countdownRef.current = setInterval(() => {
            setCountdown(prev => {
                if (prev <= 1) {
                    if (countdownRef.current) clearInterval(countdownRef.current);
                    // Move to next lead using snapshotted queue
                    setCurrentIndex(i => {
                        const nextIdx = i + 1;
                        if (nextIdx >= dialQueueRef.current.length) {
                            setState('completed');
                            isActiveRef.current = false;
                            return i;
                        }
                        setState('dialing');
                        return nextIdx;
                    });
                    return COUNTDOWN_SECONDS;
                }
                return prev - 1;
            });
        }, 1000);
    }, []);

    // Auto-dial when state transitions to 'dialing' and we have a new index
    useEffect(() => {
        if (state === 'dialing' && currentLead && isActiveRef.current) {
            const timer = setTimeout(() => dialCurrent(), 800);
            return () => clearTimeout(timer);
        }
    }, [state, currentIndex, currentLead, dialCurrent]);

    // Handle disposition selection
    const selectDisposition = (dispositionId: string) => {
        if (!currentLead) return;

        // Pull the actual call duration / SID from the dialer ref. The Dialer
        // captures these on disconnect; reading them here gives us real values
        // instead of the zeros we used to log.
        const lastInfo = dialerRef.current?.getLastCallInfo?.() || { duration: 0, callSid: '', number: '' };

        // Update lead status
        onLeadUpdate(currentLead.id, dispositionId);

        // Log the call with notes
        onCallLog(currentLead.phone, lastInfo.duration, dispositionId, lastInfo.callSid, callNotes);

        setTotalCalled(prev => prev + 1);
        setCallNotes('');

        // Start countdown for next call (use snapshotted queue length)
        if (currentIndex + 1 < dialQueueRef.current.length && isActiveRef.current) {
            startCountdown();
        } else {
            setState('completed');
            isActiveRef.current = false;
        }
    };

    const pause = () => {
        if (countdownRef.current) clearInterval(countdownRef.current);
        isActiveRef.current = false;
        setState('paused');
    };

    const resume = () => {
        isActiveRef.current = true;
        startCountdown();
    };

    const stop = () => {
        if (countdownRef.current) clearInterval(countdownRef.current);
        // Mark inactive FIRST so the auto-dial effect doesn't immediately
        // re-fire when state transitions during this teardown.
        isActiveRef.current = false;
        // Hang up any in-flight call (ringing or connected) so the recipient
        // doesn't keep ringing in the background after the agent clicks Stop.
        try { dialerRef.current?.hangUp(); } catch (err) { console.warn('Hang up on stop failed:', err); }
        setState('idle');
        setCurrentIndex(0);
    };

    const skipToNext = () => {
        if (countdownRef.current) clearInterval(countdownRef.current);
        // Same reason as stop(): if a call is still ringing, kill it before
        // moving on so we don't end up with two concurrent calls.
        try { dialerRef.current?.hangUp(); } catch (err) { console.warn('Hang up on skip failed:', err); }
        setCurrentIndex(i => {
            const nextIdx = i + 1;
            if (nextIdx >= dialQueueRef.current.length) {
                setState('completed');
                isActiveRef.current = false;
                return i;
            }
            setState('dialing');
            return nextIdx;
        });
    };

    // Show progress while we're in the disposition / countdown phase too,
    // not just at "completed". Otherwise the bar lags one step behind.
    const completedInProgress =
        state === 'disposition' || state === 'countdown' || state === 'completed' ? 1 : 0;
    const progress = activeQueue.length > 0
        ? ((currentIndex + completedInProgress) / activeQueue.length) * 100
        : 0;

    if (leads.length === 0) {
        return (
            <div className="pd-empty">
                <div className="pd-empty-icon">📱</div>
                <h3>Power Dialer</h3>
                <p>Upload leads in the Leads tab first, then use Power Dialer to auto-call through them.</p>
            </div>
        );
    }

    return (
        <div className="pd-container">
            {/* Header / Controls */}
            <div className="pd-header">
                <div className="pd-title">
                    <span className="pd-icon"><Zap {...ICON_DEFAULTS} size={20} /></span>
                    <h2>Power Dialer</h2>
                    <span className="pd-stats">
                        {totalCalled} called · {Math.max(activeQueue.length - totalCalled, 0)} remaining
                        {dncSkipped > 0 ? ` · ${dncSkipped} DNC skipped` : ''}
                    </span>
                </div>

                <div className="pd-controls">
                    {state === 'idle' && (
                        <button
                            className="btn-primary pd-start-btn"
                            onClick={start}
                            disabled={callableLeads.length === 0 || dialerStatus !== 'ready'}
                        >
                            <Play {...ICON_DEFAULTS} /> Start Dialing ({callableLeads.length} leads)
                        </button>
                    )}
                    {(state === 'countdown' || state === 'dialing') && (
                        <button className="btn-secondary" onClick={pause}>
                            <Pause {...ICON_DEFAULTS} /> Pause
                        </button>
                    )}
                    {state === 'paused' && (
                        <button className="btn-primary" onClick={resume}>
                            <Play {...ICON_DEFAULTS} /> Resume
                        </button>
                    )}
                    {state !== 'idle' && state !== 'completed' && (
                        <button className="btn-danger" onClick={stop}>
                            <Square {...ICON_DEFAULTS} /> Stop
                        </button>
                    )}
                    {state === 'completed' && (
                        <button className="btn-primary" onClick={() => { setState('idle'); setCurrentIndex(0); }}>
                            <RotateCcw {...ICON_DEFAULTS} /> Restart
                        </button>
                    )}
                </div>
            </div>

            {/* Progress Bar */}
            {state !== 'idle' && (
                <div className="pd-progress">
                    <div className="pd-progress-bar" style={{ width: `${progress}%` }} />
                    <span className="pd-progress-text">
                        Lead {Math.min(currentIndex + 1, activeQueue.length)} of {activeQueue.length}
                    </span>
                </div>
            )}

            {/* Dialer not ready warning */}
            {dialerStatus !== 'ready' && dialerStatus !== 'on-call' && state === 'idle' && (
                <div className="pd-warning">
                    <AlertTriangle {...ICON_DEFAULTS} size={14} /> Go Online in the Dialer first before starting Power Dialer
                </div>
            )}

            {/* Current Lead Card */}
            {currentLead && state !== 'idle' && state !== 'completed' && (
                <div className="pd-lead-card">
                    <div className="pd-lead-header">
                        <span className="pd-lead-badge">
                            {state === 'dialing' ? '📞 Dialing...' :
                                state === 'on-call' ? '🔴 On Call' :
                                    state === 'disposition' ? '📋 Select Outcome' :
                                        state === 'countdown' ? `⏳ Next in ${countdown}s` :
                                            state === 'paused' ? '⏸ Paused' : ''}
                        </span>
                    </div>
                    <div className="pd-lead-info">
                        <h3 className="pd-lead-name">
                            <span>
                                {(currentLead.firstName || currentLead.lastName)
                                    ? `${currentLead.firstName} ${currentLead.lastName}`.trim()
                                    : 'Unknown Lead'}
                            </span>
                            <span className="pd-lead-phone">{formatPhone(currentLead.phone)}</span>
                        </h3>
                        {currentLead.company && (
                            <p className="pd-lead-company">{currentLead.company}</p>
                        )}
                        {(() => {
                            const visible = cardConfig
                                .filter((f) => f.enabled)
                                .filter((f) => ![
                                    'first_name', 'last_name', 'firstname', 'lastname',
                                    'company', 'phone', 'phone_number',
                                ].includes(f.key))
                                .map((f) => ({ f, value: getLeadValue(currentLead, f.key) }))
                                .filter((x) => x.value);
                            if (visible.length === 0) return null;
                            return (
                                <div className="pd-lead-details">
                                    {visible.map(({ f, value }) => (
                                        <span key={f.key} title={labelForField(f.key)}>
                                            {iconForField(f.key)} {value}
                                        </span>
                                    ))}
                                </div>
                            );
                        })()}
                        {/* Hang Up button during active call */}
                        {(state === 'dialing' || state === 'on-call') && (
                            <button
                                className="btn-danger pd-hangup-btn"
                                onClick={() => dialerRef.current?.hangUp()}
                            >
                                <PhoneOff {...ICON_DEFAULTS} /> Hang Up
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Disposition Buttons */}
            {state === 'disposition' && (
                <div className="pd-disposition">
                    <h3>How did the call go?</h3>
                    <textarea
                        className="pd-notes"
                        placeholder="Add call notes (optional)..."
                        value={callNotes}
                        onChange={(e) => setCallNotes(e.target.value)}
                        rows={2}
                    />
                    <div className="pd-disposition-grid">
                        {DISPOSITIONS.map(d => (
                            <button
                                key={d.id}
                                className="pd-disposition-btn"
                                style={{ '--dispo-color': d.color } as React.CSSProperties}
                                onClick={() => selectDisposition(d.id)}
                            >
                                {d.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Countdown */}
            {state === 'countdown' && (
                <div className="pd-countdown">
                    <div className="pd-countdown-circle">
                        <span className="pd-countdown-number">{countdown}</span>
                    </div>
                    <p>Dialing next lead in {countdown} seconds...</p>
                    <div className="pd-countdown-actions">
                        <button className="btn-primary" onClick={skipToNext}>
                            <SkipForward {...ICON_DEFAULTS} /> Skip & Next
                        </button>
                        <button className="btn-secondary" onClick={pause}>
                            <Pause {...ICON_DEFAULTS} /> Pause
                        </button>
                    </div>
                </div>
            )}

            {/* Completed State */}
            {state === 'completed' && (
                <div className="pd-completed">
                    <div className="pd-completed-icon">🎉</div>
                    <h3>All Done!</h3>
                    <p>Called {totalCalled} leads out of {activeQueue.length}</p>
                </div>
            )}

            {/* Lead Queue Preview */}
            {state !== 'idle' && activeQueue.length > 0 && (
                <div className="pd-queue">
                    <h4>Up Next</h4>
                    <div className="pd-queue-list">
                        {activeQueue.slice(currentIndex + 1, currentIndex + 4).map((lead, i) => (
                            <div key={lead.id} className="pd-queue-item">
                                <span className="pd-queue-number">{i + 2}</span>
                                <span>{lead.firstName} {lead.lastName}</span>
                                <span className="pd-queue-company">{lead.company}</span>
                            </div>
                        ))}
                        {activeQueue.length - currentIndex - 1 > 3 && (
                            <div className="pd-queue-more">
                                +{activeQueue.length - currentIndex - 4} more leads...
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
