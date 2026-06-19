'use client';

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import { Device, Call } from '@twilio/voice-sdk';
import {
    resolveConfig,
    labelForField,
    iconForField,
    type CallCardField,
} from '@/lib/callCardConfig';
import { formatPhone } from '@/lib/format';
import {
    Phone,
    PhoneOff,
    PhoneIncoming,
    PhoneOutgoing,
    Mic,
    MicOff,
    Hash,
    PhoneCall,
    X,
    AlertTriangle,
    Users,
    ICON_DEFAULTS,
} from '@/components/Icon';
import { supabase } from '@/lib/supabase';
import { findTwilioRemoteStream } from '@/lib/twilioRemoteStream';

interface DialerProps {
    onCallStart?: (number: string) => void;
    /**
     * Called when a call ends. `disposition` is:
     *   'completed' — call was answered, has real talk-time duration
     *   'no-answer' — rang but never accepted; duration will be 0
     *   'failed'    — Twilio error before or during the call
     * `direction` and `number` are emitted so the parent can log inbound rows
     * correctly without having to track the incoming-call state itself.
     */
    onCallEnd?: (
        duration: number,
        callSid: string,
        disposition?: 'completed' | 'no-answer' | 'failed',
        direction?: 'inbound' | 'outbound',
        number?: string,
    ) => void;
    onStatusChange?: (status: AgentStatus) => void;
    /**
     * Fires the moment the Twilio Call SID is known (on the `accept` event),
     * and again with `null` when the call ends. Lets the parent wire up
     * live-call features like the transcript pane.
     */
    onCallSidChange?: (callSid: string | null) => void;
    /**
     * Fires with the customer's remote audio MediaStream once it's available
     * after a call is accepted, and `null` when the call ends. Used by
     * LiveCoach in browser-STT mode to feed Whisper for customer-side
     * transcription.
     */
    onRemoteStreamChange?: (stream: MediaStream | null) => void;
    /** UUID — used for agent_status broadcasts and joining `profiles.id`. */
    agentId?: string;
    /**
     * The Voice SDK identity to register with Twilio. Should equal the
     * agent's email so inbound `<Dial><Client>email</Client>` matches.
     * Falls back to agentId (UUID) for backward compat — but the inbound
     * fanout will NOT find the agent unless this is set to the email.
     */
    twilioIdentity?: string;
    leadInfo?: {
        name: string;
        company: string;
        phone: string;
        email?: string;
        city?: string;
        state?: string;
        custom1?: string;
        custom2?: string;
        custom3?: string;
        /** Raw CSV column → value map. Used by the admin-configurable card. */
        extra?: Record<string, string>;
    } | null;
}

/**
 * Best-effort lookup of a field's value from the leadInfo blob. Tries the
 * raw CSV (extra) first since that's what the admin-config keys point at,
 * then falls back to the predefined fields the importer also populates.
 */
function getLeadFieldValue(
    info: NonNullable<DialerProps['leadInfo']>,
    key: string,
): string {
    const fromExtra = info.extra?.[key];
    if (fromExtra) return fromExtra;
    switch (key) {
        case 'phone':
        case 'phone_number':
            return info.phone || '';
        case 'first_name':
        case 'firstname':
            return info.name?.split(' ')[0] || '';
        case 'last_name':
        case 'lastname':
            return info.name?.split(' ').slice(1).join(' ') || '';
        case 'company':
            return info.company || '';
        case 'email':
            return info.email || '';
        case 'city':
            return info.city || '';
        case 'state':
            return info.state || '';
        case 'mc_number':
        case 'custom_field_1':
            return info.custom1 || '';
        case 'fleet_size':
        case 'custom_field_2':
            return info.custom2 || '';
        case 'current_eld':
        case 'custom_field_3':
            return info.custom3 || '';
        default:
            return '';
    }
}

export interface DialerHandle {
    makeCall: (number: string) => Promise<void>;
    getStatus: () => AgentStatus;
    hangUp: () => void;
    /**
     * Returns details of the call that most recently disconnected.
     * Used by PowerDialer to log the real duration / call SID instead of zeros.
     */
    getLastCallInfo: () => { duration: number; callSid: string; number: string };
}

type AgentStatus = 'offline' | 'connecting' | 'ready' | 'on-call' | 'wrap-up';

const Dialer = forwardRef<DialerHandle, DialerProps>(function Dialer({ onCallStart, onCallEnd, onStatusChange, onCallSidChange, onRemoteStreamChange, agentId, twilioIdentity, leadInfo }, ref) {
    const [device, setDevice] = useState<Device | null>(null);
    const [activeCall, setActiveCall] = useState<Call | null>(null);
    const [agentStatus, setAgentStatus] = useState<AgentStatus>('offline');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [callDuration, setCallDuration] = useState(0);
    const [isMuted, setIsMuted] = useState(false);
    const [incomingCall, setIncomingCall] = useState<Call | null>(null);
    const [error, setError] = useState<string>('');
    const [callStatus, setCallStatus] = useState<string>('');
    const [activeNumber, setActiveNumber] = useState<string>('');
    /** Direction of the currently-active call. Drives the "Calling" vs "From"
     *  label on the active-call strip and any direction-sensitive logic. */
    const [activeDirection, setActiveDirection] = useState<'inbound' | 'outbound'>('outbound');
    const [showKeypad, setShowKeypad] = useState(false);
    const [cardConfig, setCardConfig] = useState<CallCardField[]>([]);

    // ── Call-transfer state ──────────────────────────────────────────
    /** Online colleagues you can transfer to. Identity = their email — used
     *  to ring their browser via Twilio Voice SDK `client:identity`. */
    interface TransferOption {
        id: string;            // agent_id (uuid)
        agent_name: string;
        identity: string;      // email
        role: string;
    }
    interface ConferenceParticipant {
        id: number; conference_name: string; call_sid: string;
        role: 'agent' | 'customer' | 'transfer-target' | 'monitor';
        display_name: string | null; phone_number: string | null;
        is_muted: boolean; joined_at: string; left_at: string | null;
    }
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [transferOptions, setTransferOptions] = useState<TransferOption[]>([]);
    const [transferTargetIdentity, setTransferTargetIdentity] = useState('');
    const [transferTargetName, setTransferTargetName] = useState('');
    /** Off-platform fallback — escalate to an Indian phone number when no
     *  online colleague is available. */
    const [transferTargetPhone, setTransferTargetPhone] = useState('');
    const [transferBusy, setTransferBusy] = useState(false);
    const [transferError, setTransferError] = useState('');
    /** Conference participants (transfer target + monitor) we know about
     *  via Supabase Realtime. Drives the "Senior connected" indicator. */
    const [conferenceParticipants, setConferenceParticipants] = useState<ConferenceParticipant[]>([]);
    /** True once we've kicked off a transfer for the current call. */
    const [transferInProgress, setTransferInProgress] = useState(false);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const durationRef = useRef(0);
    const callSidRef = useRef('');
    // Snapshot of the last completed call — survives state resets so the
    // PowerDialer (and other consumers) can read duration/sid after the
    // dialer has already returned to 'ready'.
    const lastCallInfoRef = useRef<{ duration: number; callSid: string; number: string }>({
        duration: 0,
        callSid: '',
        number: '',
    });
    // Tracks the in-flight Twilio Call from the moment we dial it. We need
    // this because `activeCall` state isn't set until the 'accept' event,
    // so calls that are still ringing previously had no hang-up handle.
    const currentCallRef = useRef<Call | null>(null);
    // Mirrors `activeCall` state so the mute/hang-up handlers can read the
    // current call without depending on React having committed the state
    // update — handy for inbound, where a clicked Mute can race the accept
    // commit and silently no-op against a stale-null `activeCall`.
    const activeCallRef = useRef<Call | null>(null);
    /** True once the customer (or our SDK) actually accepted the call. If
     *  it stays false through `disconnect`, the call rang but was never
     *  answered — we log it as no-answer with duration 0 instead of
     *  inheriting the previous call's duration. */
    const wasAcceptedRef = useRef(false);
    /** Inbound-only refs — captured on accept so the disconnect handler can
     *  emit the right row even though `incomingCall` state has been cleared. */
    const inboundCallerRef = useRef<string>('');
    const inboundParentSidRef = useRef<string>('');

    /**
     * Disconnect whatever call is currently ringing, connecting, or active.
     * Called by the local Hang Up button and by PowerDialer (via the ref).
     */
    const performHangUp = useCallback(() => {
        // Prefer the ref values so the handler works even if the React state
        // update from accept/incoming hasn't committed yet by the time the
        // user clicks Hang Up.
        const call = activeCallRef.current || activeCall || currentCallRef.current;
        if (!call) {
            console.warn('[dialer] hang-up clicked but no live call to disconnect');
            return;
        }
        try {
            call.disconnect();
        } catch (err) {
            console.error('Hang up failed:', err);
        }
        currentCallRef.current = null;
    }, [activeCall]);

    // Toggle mute — uses the ref-mirrored active call so it works for both
    // inbound and outbound regardless of React batching order.
    const toggleMute = useCallback(() => {
        const call = activeCallRef.current || activeCall;
        if (!call) {
            console.warn('[dialer] mute clicked but no live call');
            return;
        }
        const newMuted = !isMuted;
        try {
            call.mute(newMuted);
            setIsMuted(newMuted);
        } catch (err) {
            console.error('Mute toggle failed:', err);
        }
    }, [activeCall, isMuted]);

    // Keep the ref in lock-step with the state mirror.
    useEffect(() => {
        activeCallRef.current = activeCall;
    }, [activeCall]);

    // Expose makeCall, getStatus, hangUp and getLastCallInfo to parent via ref
    useImperativeHandle(ref, () => ({
        makeCall: (number: string) => makeCall(number),
        getStatus: () => agentStatus,
        hangUp: () => performHangUp(),
        getLastCallInfo: () => lastCallInfoRef.current,
    }));

    // Refresh the call-card config whenever the lead changes (admin may have
    // edited it between calls) and react to cross-tab updates.
    useEffect(() => {
        const cols = leadInfo?.extra ? Object.keys(leadInfo.extra) : [];
        setCardConfig(resolveConfig(cols));
        const onStorage = (e: StorageEvent) => {
            if (e.key === 'cruzonic_call_card_config' || e.key === 'cruzonic_known_columns') {
                setCardConfig(resolveConfig(cols));
            }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [leadInfo]);

    // Notify parent of status changes + broadcast to server
    useEffect(() => {
        onStatusChange?.(agentStatus);
        // Broadcast agent status
        if (agentId) {
            fetch('/api/agent-status', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agent_id: agentId,
                    status: agentStatus,
                    current_call_number: activeNumber || '',
                    // Call SID lets admins listen-in on this exact leg.
                    current_call_sid: agentStatus === 'on-call' ? callSidRef.current : null,
                }),
            }).catch(() => { });
        }
    }, [agentStatus, onStatusChange, agentId, activeNumber]);

    // ── Heartbeat: refresh agent_status.last_updated every 60s while the
    //    dialer is alive and the agent isn't deliberately offline. The
    //    server-side inbound fanout filters out 'ready' rows older than 30
    //    min — without this ping, a closed tab would keep ringing forever.
    useEffect(() => {
        if (!agentId) return;
        if (agentStatus === 'offline') return;
        const ping = () => {
            fetch('/api/agent-status', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agent_id: agentId,
                    status: agentStatus,
                    current_call_number: activeNumber || '',
                    current_call_sid: agentStatus === 'on-call' ? callSidRef.current : null,
                }),
                keepalive: true,
            }).catch(() => { });
        };
        const interval = window.setInterval(ping, 60_000);
        return () => window.clearInterval(interval);
    }, [agentId, agentStatus, activeNumber]);

    // ── Best-effort "going offline" when the tab/browser closes or the
    //    user navigates away. Uses `keepalive: true` so the fetch survives
    //    the page unload. Same payload as the heartbeat but with status
    //    forced to 'offline' so the fanout drops this agent immediately.
    useEffect(() => {
        if (!agentId) return;
        const markOffline = () => {
            try {
                fetch('/api/agent-status', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        agent_id: agentId,
                        status: 'offline',
                        current_call_number: '',
                        current_call_sid: null,
                    }),
                    keepalive: true,
                }).catch(() => { });
            } catch { /* ignore */ }
        };
        const onVisibility = () => {
            // Tab going to background isn't the same as closing — only mark
            // offline if the page is actually being unloaded (handled below).
            if (document.visibilityState === 'hidden') {
                // Browser may persist the tab in background for a while.
                // Don't force-offline here; the heartbeat staleness cutoff
                // handles abandoned-tab cleanup after 30 min.
            }
        };
        window.addEventListener('pagehide', markOffline);
        window.addEventListener('beforeunload', markOffline);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.removeEventListener('pagehide', markOffline);
            window.removeEventListener('beforeunload', markOffline);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [agentId]);

    // Format phone number for Twilio E.164 format
    const formatE164 = (input: string): string => {
        // Remove all non-digit characters except +
        const cleaned = input.replace(/[^\d+]/g, '');

        // Already in E.164 format
        if (cleaned.startsWith('+')) return cleaned;

        // 10 digits = US number, prepend +1
        if (cleaned.length === 10) return `+1${cleaned}`;

        // 11 digits starting with 1 = US number with country code
        if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;

        // Otherwise, assume they know what they're doing, prepend +
        return `+${cleaned}`;
    };

    // Initialize Twilio Device
    const initDevice = useCallback(async () => {
        try {
            setError('');
            setAgentStatus('connecting');
            // Twilio Voice SDK identity = the agent's email when available.
            // This MUST match what the inbound voice route dials in
            // `<Dial><Client>email</Client>`; if Device registers as the
            // profile.id UUID instead, no inbound call ever reaches the browser.
            // Falls back to agentId (UUID) and then 'agent-1' for dev/unauth.
            const tokenIdentity = twilioIdentity || agentId || 'agent-1';
            const response = await fetch('/api/twilio/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: tokenIdentity }),
            });

            if (!response.ok) throw new Error('Failed to get token');

            const data = await response.json();
            const newDevice = new Device(data.token, {
                codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
                allowIncomingWhileBusy: false,
            });

            newDevice.on('registered', () => {
                setAgentStatus('ready');
            });

            newDevice.on('incoming', (call: Call) => {
                setIncomingCall(call);

                // If the caller hangs up before we pick up — or another
                // agent in the fanout accepted the call first — Twilio
                // fires `cancel` on this end. Without these listeners the
                // incoming banner stayed on screen indefinitely (and the
                // missed-call row was never logged client-side; the server
                // dial-status callback still creates one).
                const clearBanner = () => {
                    setIncomingCall((current) => (current === call ? null : current));
                    // Don't touch agentStatus if we already accepted — the
                    // accept handler owns the on-call → wrap-up transition.
                    setAgentStatus((s) => (s === 'connecting' ? 'ready' : s));
                };
                call.on('cancel', clearBanner);
                // `disconnect` fires for a never-accepted call if Twilio
                // bridges to another leg and ours is dropped. `reject` is
                // our own UI action — rejectCall already handles cleanup,
                // but wiring it here too makes the banner robust against
                // unexpected reject flows from the SDK.
                call.on('disconnect', () => {
                    // Only clear if we never accepted. Once accepted,
                    // acceptCall's own disconnect handler runs.
                    if (!wasAcceptedRef.current) clearBanner();
                });
                call.on('reject', clearBanner);
            });

            newDevice.on('error', (err) => {
                console.error('Device error:', err);
                setError(err.message || 'Device error');
            });

            newDevice.on('tokenWillExpire', async () => {
                try {
                    const res = await fetch('/api/twilio/token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ identity: tokenIdentity }),
                    });
                    if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
                    const d = await res.json();
                    newDevice.updateToken(d.token);
                } catch (refreshErr) {
                    console.error('Token refresh failed:', refreshErr);
                    setError('Twilio token refresh failed — call quality may degrade.');
                }
            });

            await newDevice.register();
            setDevice(newDevice);
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : 'Failed to connect';
            setError(errorMessage);
            setAgentStatus('offline');
            console.error('Init error:', err);
        }
    }, [agentId, twilioIdentity]);

    // Auto-go-online once we know who the agent is. Without this, calls
    // coming in to the sales number find an empty roster of `ready` agents
    // and hit the voicemail fallback — even when the agent IS signed in.
    // This effect runs exactly once per session when agentId becomes known.
    useEffect(() => {
        if (!agentId) return;
        if (device) return;
        if (agentStatus !== 'offline') return;
        initDevice();
    }, [agentId, device, agentStatus, initDevice]);

    // Start call timer
    useEffect(() => {
        if (agentStatus === 'on-call') {
            setCallDuration(0);
            durationRef.current = 0;
            timerRef.current = setInterval(() => {
                durationRef.current += 1;
                setCallDuration(durationRef.current);
            }, 1000);
        } else {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        }
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [agentStatus]);

    // Make outbound call
    const makeCall = async (numberToCall?: string) => {
        if (!device) {
            setError('Device not connected. Click "Go Online" first.');
            return;
        }

        const target = numberToCall || phoneNumber;
        if (!target) {
            setError('Enter a phone number');
            return;
        }

        const e164Number = formatE164(target);
        console.log('Calling:', e164Number, '(original:', target, ')');

        try {
            setError('');
            setCallStatus('Connecting...');
            setActiveNumber(e164Number);
            setActiveDirection('outbound');
            const call = await device.connect({
                params: {
                    To: e164Number,
                },
            });

            // Track the in-flight call immediately so a Stop / Hang Up issued
            // before the recipient picks up can still kill it.
            currentCallRef.current = call;
            // Reset accept-tracking + duration on every new call so a missed
            // call can't inherit the previous call's timer value.
            wasAcceptedRef.current = false;
            durationRef.current = 0;
            setCallDuration(0);

            call.on('ringing', () => {
                setCallStatus('Ringing...');
            });

            call.on('accept', () => {
                wasAcceptedRef.current = true;
                setAgentStatus('on-call');
                setActiveCall(call);
                setCallStatus('');
                // Capture the call SID for recording matching
                const sid = call.parameters?.CallSid || '';
                callSidRef.current = sid;
                console.log('Call SID:', sid);
                onCallStart?.(target);
                if (sid) onCallSidChange?.(sid);
                // Look up the customer's remote audio stream so the LiveCoach
                // (in browser-STT mode) can feed it to Whisper for the
                // customer-side transcription. We poll briefly because
                // Twilio attaches the <audio> element asynchronously.
                if (onRemoteStreamChange) {
                    findTwilioRemoteStream().then((stream) => {
                        if (stream) onRemoteStreamChange(stream);
                    }).catch(() => { /* swallow — agent-only transcript is fine */ });
                }
            });

            call.on('disconnect', () => {
                setAgentStatus('wrap-up');
                setCallStatus('');
                // If the customer never answered, the timer never started, so
                // duration is 0 and disposition is 'no-answer'. Otherwise the
                // call was a real conversation — disposition 'completed'.
                const accepted = wasAcceptedRef.current;
                const durationToLog = accepted ? durationRef.current : 0;
                const disposition: 'completed' | 'no-answer' = accepted ? 'completed' : 'no-answer';
                // Snapshot the call info BEFORE clearing the refs so consumers
                // (PowerDialer's getLastCallInfo) get accurate values.
                lastCallInfoRef.current = {
                    duration: durationToLog,
                    callSid: callSidRef.current,
                    number: e164Number,
                };
                onCallEnd?.(durationToLog, callSidRef.current, disposition);
                setActiveCall(null);
                setActiveNumber('');
                callSidRef.current = '';
                currentCallRef.current = null;
                wasAcceptedRef.current = false;
                onCallSidChange?.(null);
                onRemoteStreamChange?.(null);
                setTimeout(() => setAgentStatus('ready'), 5000);
            });

            call.on('cancel', () => {
                setAgentStatus('ready');
                setActiveCall(null);
                setActiveNumber('');
                setCallStatus('');
                currentCallRef.current = null;
                onCallSidChange?.(null);
                onRemoteStreamChange?.(null);
            });

            call.on('error', (err) => {
                setError(err.message);
                setAgentStatus('ready');
                setActiveCall(null);
                setCallStatus('');
                currentCallRef.current = null;
                onCallSidChange?.(null);
                onRemoteStreamChange?.(null);
            });
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : 'Call failed';
            setError(errorMessage);
            setCallStatus('');
            currentCallRef.current = null;
            onCallSidChange?.(null);
        }
    };

    // Accept incoming call
    const acceptCall = () => {
        if (!incomingCall) return;
        const call = incomingCall;
        call.accept();
        // Populate the refs FIRST so the mute / hang-up buttons that render
        // on the next tick already have a live handle, before React has
        // committed the state updates below.
        activeCallRef.current = call;
        currentCallRef.current = call;
        setActiveCall(call);
        setAgentStatus('on-call');
        setIncomingCall(null);
        // The Voice SDK gives us the CHILD call SID (the <Client> leg).
        // For recording-URL matching we want the PARENT call SID, which the
        // voice route passes through as a custom <Parameter>. Twilio exposes
        // it on either `customParameters` (Map) or `parameters` depending on
        // SDK build — try both for safety.
        const childSid = call.parameters?.CallSid || '';
        const customMap = (call as Call & { customParameters?: Map<string, string> }).customParameters;
        const parentSid =
            customMap?.get('parentCallSid')
            || ((call.parameters as Record<string, string> | undefined)?.parentCallSid)
            || '';
        const callerFrom =
            customMap?.get('callerFrom')
            || (call.parameters?.From || '')
            || '';
        // Prefer the parent SID for the call_logs row so the recording
        // status callback's CallSid lines up. Fall back to child SID.
        const logSid = parentSid || childSid;
        callSidRef.current = logSid;
        inboundParentSidRef.current = logSid;
        const cleanCaller = callerFrom.replace(/^client:/, '');
        inboundCallerRef.current = cleanCaller;
        // Surface the caller's number on the on-call strip — without this,
        // the agent sees no caller ID once they accept and the incoming
        // banner disappears.
        setActiveNumber(cleanCaller);
        setActiveDirection('inbound');
        // Reset accept tracking + timer base so duration starts at 0.
        wasAcceptedRef.current = true;
        durationRef.current = 0;
        setCallDuration(0);
        if (logSid) onCallSidChange?.(logSid);

        // Same as the outbound flow — find the customer's remote stream
        // and hand it to the parent so LiveCoach can transcribe it.
        if (onRemoteStreamChange) {
            findTwilioRemoteStream().then((stream) => {
                if (stream) onRemoteStreamChange(stream);
            }).catch(() => { /* swallow */ });
        }

        call.on('disconnect', () => {
            setAgentStatus('wrap-up');
            // wasAcceptedRef is true here by construction (we only attach
            // this handler after accept). Duration is the live timer value.
            const durationToLog = durationRef.current;
            const sidToLog = inboundParentSidRef.current || callSidRef.current;
            const numberToLog = inboundCallerRef.current || '';
            lastCallInfoRef.current = {
                duration: durationToLog,
                callSid: sidToLog,
                number: numberToLog,
            };
            onCallEnd?.(durationToLog, sidToLog, 'completed', 'inbound', numberToLog);
            setActiveCall(null);
            setActiveNumber('');
            activeCallRef.current = null;
            currentCallRef.current = null;
            callSidRef.current = '';
            inboundParentSidRef.current = '';
            inboundCallerRef.current = '';
            wasAcceptedRef.current = false;
            onCallSidChange?.(null);
            onRemoteStreamChange?.(null);
            setTimeout(() => setAgentStatus('ready'), 5000);
        });

        call.on('cancel', () => {
            // Caller hung up before we picked up, or another agent took it.
            // Don't log here — the server-side dial status callback owns the
            // "missed call" row for the inbound parent.
            setActiveCall(null);
            setActiveNumber('');
            activeCallRef.current = null;
            currentCallRef.current = null;
            callSidRef.current = '';
            inboundParentSidRef.current = '';
            inboundCallerRef.current = '';
            onCallSidChange?.(null);
            onRemoteStreamChange?.(null);
            setAgentStatus('ready');
        });
    };

    // Reject incoming call
    const rejectCall = () => {
        if (incomingCall) {
            incomingCall.reject();
            setIncomingCall(null);
        }
    };

    // Hang up — delegates to performHangUp so the same code path handles
    // ringing, connecting, and answered calls.
    const hangUp = () => {
        performHangUp();
    };

    // ── Call transfer (warm) ──────────────────────────────────────────
    /** Open the transfer modal and lazily load the list of currently
     *  online colleagues. Transfer rings their browser via Twilio Voice SDK
     *  (`client:identity`); the optional phone field is an off-platform
     *  escape hatch. */
    const openTransferModal = useCallback(async () => {
        setTransferError('');
        setShowTransferModal(true);
        try {
            const [statusRes, agentsRes] = await Promise.all([
                fetch('/api/agent-status'),
                fetch('/api/admin/agents'),
            ]);
            const statusData = await statusRes.json();
            const agentsData = await agentsRes.json();
            const readyIds = new Set<string>(
                (statusData.statuses || [])
                    .filter((s: { status?: string }) => s.status === 'ready')
                    .map((s: { agent_id: string }) => s.agent_id),
            );
            const online: TransferOption[] = (agentsData.agents || [])
                .filter((a: { id: string; email: string; full_name?: string | null; role?: string; is_active?: boolean }) => {
                    if (!a.is_active) return false;
                    if (a.id === agentId) return false; // never yourself
                    return readyIds.has(a.id);
                })
                .map((a: { id: string; email: string; full_name?: string | null; role?: string }) => ({
                    id: a.id,
                    agent_name: a.full_name || a.email,
                    identity: a.email,
                    role: a.role || 'sales',
                }));
            setTransferOptions(online);
        } catch (err) {
            console.warn('failed to load transfer options', err);
        }
    }, [agentId]);

    const closeTransferModal = useCallback(() => {
        setShowTransferModal(false);
        setTransferTargetIdentity('');
        setTransferTargetPhone('');
        setTransferTargetName('');
        setTransferError('');
    }, []);

    /** Kick off the warm transfer for the current active call. */
    const initiateTransfer = useCallback(async () => {
        const sid = callSidRef.current;
        if (!sid) return;
        const hasIdentity = transferTargetIdentity.trim().length > 0;
        const hasPhone = transferTargetPhone.trim().length > 0;
        if (!hasIdentity && !hasPhone) return;
        setTransferBusy(true);
        setTransferError('');
        try {
            const res = await fetch('/api/twilio/transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentCallSid: sid,
                    targetIdentity: hasIdentity ? transferTargetIdentity.trim() : undefined,
                    targetPhone: hasPhone ? transferTargetPhone.trim() : undefined,
                    targetName: transferTargetName.trim() || undefined,
                    agentEmail: agentId,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Transfer failed');
            setTransferInProgress(true);
            setShowTransferModal(false);
            setTransferTargetPhone('');
            setTransferTargetName('');
        } catch (err: unknown) {
            setTransferError(err instanceof Error ? err.message : 'Transfer failed');
        } finally {
            setTransferBusy(false);
        }
    }, [transferTargetIdentity, transferTargetPhone, transferTargetName, agentId]);

    /** Leave the conference (warm transfer wrap-up). Drops the agent leg
     *  but lets customer + senior keep talking. */
    const leaveConference = useCallback(async () => {
        const sid = callSidRef.current;
        if (!sid) return;
        try {
            await fetch('/api/twilio/leave-conference', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callSid: sid }),
            });
        } catch (err) {
            console.warn('leave-conference failed', err);
        }
        // The agent leg will end shortly via Twilio; UI cleans itself up
        // through the existing 'disconnect' handler.
    }, []);

    // Subscribe to conference participants for the active call. When the
    // senior joins, this Realtime feed flips the indicator to "connected".
    useEffect(() => {
        if (!transferInProgress) return;
        const sid = callSidRef.current;
        if (!sid) return;
        const confName = `cf-${sid.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;

        // Prime once in case rows already exist from before subscription.
        (async () => {
            const { data } = await supabase
                .from('conference_participants')
                .select('*')
                .eq('conference_name', confName)
                .order('joined_at', { ascending: true });
            if (data) setConferenceParticipants(data as ConferenceParticipant[]);
        })();

        const channel = supabase
            .channel(`conf-${confName}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'conference_participants',
                    filter: `conference_name=eq.${confName}`,
                },
                (payload) => {
                    setConferenceParticipants((prev) => {
                        const row = payload.new as ConferenceParticipant;
                        const idx = prev.findIndex((p) => p.call_sid === row.call_sid);
                        if (idx >= 0) {
                            const next = [...prev];
                            next[idx] = row;
                            return next;
                        }
                        return [...prev, row];
                    });
                },
            )
            .subscribe();

        return () => { supabase.removeChannel(channel); };
    }, [transferInProgress]);

    // Reset transfer state when the agent's call ends.
    useEffect(() => {
        if (agentStatus !== 'on-call') {
            setTransferInProgress(false);
            setConferenceParticipants([]);
        }
    }, [agentStatus]);

    /** True once the transfer target has actually joined the conference. */
    const seniorConnected = conferenceParticipants.some(
        (p) => p.role === 'transfer-target' && !p.left_at && p.joined_at,
    );
    const seniorParticipant = conferenceParticipants.find((p) => p.role === 'transfer-target');

    // Send DTMF
    const sendDigit = (digit: string) => {
        if (activeCall) {
            activeCall.sendDigits(digit);
        }
        if (!activeCall) {
            setPhoneNumber((prev) => prev + digit);
        }
    };

    // Format duration
    const formatDuration = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    const statusColors: Record<AgentStatus, string> = {
        offline: '#6b7280',
        connecting: '#f59e0b',
        ready: '#10b981',
        'on-call': '#ef4444',
        'wrap-up': '#f59e0b',
    };

    const statusLabels: Record<AgentStatus, string> = {
        offline: 'Offline',
        connecting: 'Connecting...',
        ready: 'Ready',
        'on-call': 'On Call',
        'wrap-up': 'Wrap Up',
    };

    const keypadDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

    return (
        <div className="dialer-container">
            {/* Status Bar */}
            <div className="status-bar">
                <div className="status-indicator" style={{ background: statusColors[agentStatus] }} />
                <span className="status-text">{statusLabels[agentStatus]}</span>
                {agentStatus === 'on-call' && (
                    <span className="call-timer">{formatDuration(callDuration)}</span>
                )}
                {callStatus && (
                    <span className="call-status">{callStatus}</span>
                )}
            </div>

            {/* Active Call Number Display — label flips on direction so the
                agent immediately sees who's on the line for inbound. */}
            {(agentStatus === 'on-call' || callStatus) && activeNumber && (
                <div className={`active-call-info ${activeDirection === 'inbound' ? 'active-call-info-inbound' : ''}`}>
                    <span className="active-call-label">
                        {activeDirection === 'inbound'
                            ? <><PhoneIncoming {...ICON_DEFAULTS} size={14} /> Call from</>
                            : <><Phone {...ICON_DEFAULTS} size={14} /> Calling</>}
                    </span>
                    <span className="active-call-number">{formatPhone(activeNumber)}</span>
                </div>
            )}

            {/* Error Message */}
            {error && (
                <div className="error-banner">
                    <span><AlertTriangle {...ICON_DEFAULTS} size={14} /> {error}</span>
                    <button onClick={() => setError('')} aria-label="Dismiss error"><X {...ICON_DEFAULTS} size={14} /></button>
                </div>
            )}

            {/* Incoming Call Banner */}
            {incomingCall && (() => {
                // Twilio Call.parameters carries From/To/CallSid; for PSTN
                // inbound, From is a phone number. For browser-to-browser
                // (transfers, monitor calls) it'll be a `client:identity`.
                const rawFrom = incomingCall.parameters?.From || '';
                const isClient = rawFrom.startsWith('client:');
                const callerLabel = isClient
                    ? rawFrom.replace(/^client:/, '')
                    : rawFrom
                        ? formatPhone(rawFrom)
                        : 'Unknown caller';
                const toNumber = incomingCall.parameters?.To || '';
                // For PSTN inbound, To is one of OUR Twilio numbers — tells
                // the agent which line (sales vs support) the call came in on.
                const calledLine = toNumber && !toNumber.startsWith('client:')
                    ? formatPhone(toNumber)
                    : '';
                const isTransfer = isClient; // browser-to-browser routing
                return (
                    <div className={`incoming-banner ${isTransfer ? 'incoming-banner-transfer' : ''}`}>
                        <div className="incoming-info">
                            <span className="incoming-icon">
                                <PhoneIncoming {...ICON_DEFAULTS} size={22} strokeWidth={2.25} />
                            </span>
                            <div className="incoming-text">
                                <span className="incoming-label">
                                    {isTransfer ? 'Incoming transfer' : 'Incoming call'}
                                </span>
                                <strong className="incoming-from">{callerLabel}</strong>
                                {calledLine && (
                                    <span className="incoming-line">to {calledLine}</span>
                                )}
                            </div>
                        </div>
                        <div className="incoming-actions">
                            <button className="btn-accept" onClick={acceptCall} title="Accept">
                                <Phone {...ICON_DEFAULTS} size={16} /> Accept
                            </button>
                            <button className="btn-reject" onClick={rejectCall} title="Reject">
                                <PhoneOff {...ICON_DEFAULTS} size={16} /> Reject
                            </button>
                        </div>
                    </div>
                );
            })()}

            {/* Lead Info Screen Pop — fields are admin-configurable. */}
            {leadInfo && agentStatus === 'on-call' && (
                <div className="lead-popup">
                    <h3>{leadInfo.name || 'Unknown Caller'}</h3>
                    {leadInfo.company && <p className="lead-company">{leadInfo.company}</p>}
                    <div className="lead-details">
                        {cardConfig
                            .filter((f) => f.enabled)
                            // Skip name/company — already rendered as the header above.
                            .filter((f) => !['first_name', 'last_name', 'firstname', 'lastname', 'company'].includes(f.key))
                            .map((f) => {
                                const value = getLeadFieldValue(leadInfo, f.key);
                                if (!value) return null;
                                return (
                                    <div key={f.key}>
                                        <span>{iconForField(f.key)}</span> {value}
                                        <span className="lead-field-label"> — {labelForField(f.key)}</span>
                                    </div>
                                );
                            })}
                    </div>
                </div>
            )}

            {/* Phone Input */}
            {agentStatus !== 'on-call' && agentStatus !== 'connecting' && (
                <div className="phone-input-group">
                    <input
                        type="tel"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        placeholder="+13075551234"
                        className="phone-input"
                        disabled={agentStatus === 'offline'}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && phoneNumber) makeCall();
                        }}
                    />
                    <div className="phone-hint">Enter number with country code: +1 for US, +91 for India</div>
                </div>
            )}

            {/* Keypad */}
            {showKeypad && (
                <div className="keypad">
                    {keypadDigits.map((digit) => (
                        <button
                            key={digit}
                            className="keypad-btn"
                            onClick={() => sendDigit(digit)}
                        >
                            {digit}
                        </button>
                    ))}
                </div>
            )}

            {/* Action Buttons */}
            <div className="action-buttons">
                {agentStatus === 'offline' && (
                    <button className="btn-primary btn-connect" onClick={initDevice}>
                        <PhoneCall {...ICON_DEFAULTS} /> Go Online
                    </button>
                )}

                {agentStatus === 'connecting' && (
                    <button className="btn-primary btn-connect btn-connecting" disabled>
                        <span className="spinner"></span> Connecting to Twilio...
                    </button>
                )}

                {agentStatus === 'ready' && (
                    <>
                        <button
                            className="btn-primary btn-call"
                            onClick={() => makeCall()}
                            disabled={!phoneNumber}
                        >
                            <Phone {...ICON_DEFAULTS} /> Call
                        </button>
                        <button
                            className="btn-secondary"
                            onClick={() => setShowKeypad(!showKeypad)}
                            aria-label="Toggle keypad"
                            title="Toggle keypad"
                        >
                            <Hash {...ICON_DEFAULTS} />
                        </button>
                        <button
                            className="btn-secondary btn-disconnect"
                            onClick={() => {
                                device?.destroy();
                                setDevice(null);
                                setAgentStatus('offline');
                            }}
                        >
                            Go Offline
                        </button>
                    </>
                )}

                {agentStatus === 'on-call' && (
                    <>
                        <button
                            className={`btn-secondary ${isMuted ? 'btn-muted' : ''}`}
                            onClick={toggleMute}
                        >
                            {isMuted ? <><MicOff {...ICON_DEFAULTS} /> Muted</> : <><Mic {...ICON_DEFAULTS} /> Mute</>}
                        </button>
                        <button
                            className="btn-secondary"
                            onClick={() => setShowKeypad(!showKeypad)}
                        >
                            <Hash {...ICON_DEFAULTS} /> Keypad
                        </button>
                        {!transferInProgress && (
                            <button
                                className="btn-secondary"
                                onClick={openTransferModal}
                                title="Transfer this call to a senior"
                            >
                                <PhoneOutgoing {...ICON_DEFAULTS} /> Transfer
                            </button>
                        )}
                        {transferInProgress && seniorConnected && (
                            <button className="btn-secondary" onClick={leaveConference}>
                                <Users {...ICON_DEFAULTS} /> Hand off &amp; leave
                            </button>
                        )}
                        <button className="btn-danger btn-hangup" onClick={hangUp}>
                            <PhoneOff {...ICON_DEFAULTS} /> Hang Up
                        </button>
                    </>
                )}

                {/* Transfer status banner — shows up the moment we initiate
                    the warm transfer and morphs once the senior connects. */}
                {agentStatus === 'on-call' && transferInProgress && (
                    <div className={`xfer-banner ${seniorConnected ? 'xfer-banner-live' : 'xfer-banner-ringing'}`}>
                        {seniorConnected ? (
                            <>
                                <span className="xfer-dot is-live" />
                                <div>
                                    <strong>{seniorParticipant?.display_name || 'Senior'} joined the call</strong>
                                    <p>You can mute yourself and let them take over, or click <em>Hand off &amp; leave</em>.</p>
                                </div>
                            </>
                        ) : (
                            <>
                                <span className="xfer-dot xfer-dot-ringing" />
                                <div>
                                    <strong>Calling {seniorParticipant?.display_name || 'Senior'}…</strong>
                                    <p>Keep talking to the customer — they&rsquo;re still connected.</p>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {agentStatus === 'wrap-up' && (
                    <div className="wrapup-info">
                        <p>Call ended • {formatDuration(callDuration)}</p>
                        <p className="wrapup-timer">Auto-ready in 5s...</p>
                    </div>
                )}
            </div>

            {/* ── Transfer modal ── */}
            {showTransferModal && (
                <div className="app-modal-backdrop" onClick={closeTransferModal}>
                    <div className="app-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="app-modal-head">
                            <h3><PhoneOutgoing {...ICON_DEFAULTS} size={16} /> Transfer call</h3>
                            <button className="app-modal-close" onClick={closeTransferModal} aria-label="Close">
                                <X {...ICON_DEFAULTS} size={14} />
                            </button>
                        </div>
                        <div className="app-modal-body">
                            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 12px' }}>
                                The customer will stay on the call with you while we ring the senior.
                                When they answer, mute yourself or click <em>Hand off &amp; leave</em>.
                            </p>

                            {transferOptions.length > 0 ? (
                                <label className="form-group" style={{ marginBottom: 12 }}>
                                    <span style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.05em' }}>
                                        Online colleagues — their browser will ring
                                    </span>
                                    <div className="xfer-options">
                                        {transferOptions.map((s) => (
                                            <button
                                                key={s.id}
                                                type="button"
                                                className={`xfer-option ${transferTargetIdentity === s.identity ? 'is-selected' : ''}`}
                                                onClick={() => {
                                                    setTransferTargetIdentity(s.identity);
                                                    setTransferTargetName(s.agent_name);
                                                    setTransferTargetPhone(''); // mutually exclusive
                                                }}
                                            >
                                                <strong>{s.agent_name}</strong>
                                                <span style={{ textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.04em' }}>{s.role}</span>
                                            </button>
                                        ))}
                                    </div>
                                </label>
                            ) : (
                                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
                                    No colleagues are online right now. You can still escalate to a phone number below.
                                </p>
                            )}

                            <label className="form-group">
                                <span style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.05em' }}>
                                    Or escalate to a phone number
                                </span>
                                <input
                                    type="tel"
                                    placeholder="+91…"
                                    value={transferTargetPhone}
                                    onChange={(e) => {
                                        setTransferTargetPhone(e.target.value);
                                        if (e.target.value) setTransferTargetIdentity('');
                                    }}
                                />
                            </label>

                            {transferError && (
                                <div className="login-error" style={{ marginTop: 10 }}>
                                    <AlertTriangle {...ICON_DEFAULTS} size={14} /> {transferError}
                                </div>
                            )}
                        </div>
                        <div className="app-modal-actions">
                            <button className="btn-secondary" onClick={closeTransferModal} disabled={transferBusy}>
                                Cancel
                            </button>
                            <button
                                className="btn-primary"
                                onClick={initiateTransfer}
                                disabled={transferBusy || (!transferTargetIdentity.trim() && !transferTargetPhone.trim())}
                            >
                                {transferBusy ? 'Connecting…' : 'Start transfer'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default Dialer;
