const { useState, useEffect, useCallback } = React;

function Toggle({ checked, onChange, label, subtitle }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 p-3.5 rounded-xl bg-[#172033]/80 border border-slate-400/15 hover:border-blue-500/40 transition text-left"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-[#F8FAFC]">{label}</div>
        {subtitle && <div className="text-xs text-[#94A3B8] mt-0.5">{subtitle}</div>}
      </div>
      <span
        className={`shrink-0 w-11 h-6 rounded-full p-0.5 transition-colors flex items-center ${
          checked ? 'bg-[#2563EB]' : 'bg-[#0B1220] border border-slate-400/20'
        }`}
      >
        <span
          className={`w-5 h-5 rounded-full bg-[#F8FAFC] shadow transform transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  );
}

function SliderField({ label, value, min, max, step, unit, hint, onChange }) {
  return (
    <div className="p-3.5 rounded-xl bg-[#172033]/70 border border-slate-400/15 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-[#E2E8F0]">{label}</span>
        <span className="px-2.5 py-0.5 rounded-lg bg-[#2563EB]/20 border border-[#3B82F6]/40 text-xs font-mono font-semibold text-[#60A5FA]">
          {value}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer"
      />
      {hint && <div className="text-[11px] text-[#94A3B8]">{hint}</div>}
    </div>
  );
}

function NumberField({ label, value, min, max, hint, onChange }) {
  return (
    <label className="block p-3.5 rounded-xl bg-[#172033]/70 border border-slate-400/15 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[#E2E8F0]">{label}</span>
        <span className="text-[11px] text-[#64748B]">({min} – {max})</span>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full px-3 py-2 rounded-lg bg-[#0B1220] border border-slate-400/20 text-sm font-mono text-[#F8FAFC] focus:outline-none focus:border-[#3B82F6]"
      />
      {hint && <div className="text-[11px] text-[#94A3B8]">{hint}</div>}
    </label>
  );
}

function AdminApp() {
  const [password, setPassword] = useState(() => localStorage.getItem('us_admin_pw') || '');
  const [pwInput, setPwInput] = useState('');
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState('overview');
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const fetchState = useCallback(async (pw) => {
    if (!pw) return;
    setLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch('/api/admin/state', {
        headers: { Authorization: `Bearer ${pw}` },
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem('us_admin_pw');
          setAuthed(false);
        }
        throw new Error(data.error || 'Authentication failed');
      }
      localStorage.setItem('us_admin_pw', pw);
      setPassword(pw);
      setAuthed(true);
      setState(data);
      setDraft((prev) => (prev && dirty ? prev : data.config));
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setLoading(false);
    }
  }, [dirty]);

  useEffect(() => {
    if (password) fetchState(password);
  }, []);

  useEffect(() => {
    if (!authed || !password) return;
    const id = setInterval(() => fetchState(password), 15000);
    return () => clearInterval(id);
  }, [authed, password, fetchState]);

  const updateField = (key, val) => {
    setDraft((prev) => ({ ...prev, [key]: val }));
    setDirty(true);
    setStatusMsg('');
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      const res = await fetch('/api/admin/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${password}`,
        },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setDraft(data.config);
      setDirty(false);
      setStatusMsg('Saved & pushed live to connected apps');
      fetchState(password);
    } catch (e) {
      setErrorMsg(e.message);
    } finally {
      setSaving(false);
    }
  };

  const closeRoom = async (code) => {
    try {
      const res = await fetch(`/api/admin/rooms/${code}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${password}` },
      });
      if (res.ok) {
        setStatusMsg(`Closed Talk Room ${code}`);
        fetchState(password);
      }
    } catch (e) {
      setErrorMsg(e.message);
    }
  };

  const logout = () => {
    localStorage.removeItem('us_admin_pw');
    setPassword('');
    setAuthed(false);
    setState(null);
    setDraft(null);
    setDirty(false);
  };

  if (!authed || !draft) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[#050810]">
        <div className="w-full max-w-md modal-card rounded-3xl p-6 sm:p-8 shadow-2xl space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#2563EB]/20 border border-[#3B82F6]/40 flex items-center justify-center text-[#60A5FA] font-bold">
              US
            </div>
            <div>
              <h1 className="text-lg font-bold text-[#F8FAFC]">UniqueStream Admin</h1>
              <p className="text-xs text-[#94A3B8]">Live Runtime Control &amp; Quota Console</p>
            </div>
          </div>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/40 text-xs text-red-300">
              {errorMsg}
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              fetchState(pwInput);
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
                Admin Password
              </label>
              <input
                type="password"
                value={pwInput}
                onChange={(e) => setPwInput(e.target.value)}
                placeholder="Enter ADMIN_PASSWORD"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#0B1220] border border-slate-400/20 text-sm text-[#F8FAFC] focus:outline-none focus:border-[#3B82F6]"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-sm font-semibold text-[#F8FAFC] transition disabled:opacity-50"
            >
              {loading ? 'Connecting…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const quotaPct = state?.quota
    ? Math.min(100, Math.round((state.quota.used / Math.max(1, state.quota.budget)) * 100))
    : 0;

  const navItems = [
    { id: 'overview', label: 'Overview' },
    { id: 'youtube', label: 'YouTube' },
    { id: 'talk', label: 'Talk Rooms' },
    { id: 'rooms', label: `Live (${state?.rooms?.length || 0})` },
  ];

  return (
    <div className="min-h-screen bg-[#050810] text-[#E2E8F0] pb-24 lg:pb-8">
      {/* Top Sticky Header */}
      <header className="sticky top-0 z-30 bg-[#080D18]/90 backdrop-blur-xl border-b border-slate-400/15">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#2563EB]/20 border border-[#3B82F6]/40 flex items-center justify-center text-[#60A5FA] font-bold text-sm shrink-0">
              US
            </div>
            <div className="min-w-0">
              <div className="text-sm sm:text-base font-bold text-[#F8FAFC] truncate">
                UniqueStream Control Panel
              </div>
              <div className="text-[11px] text-[#94A3B8] truncate">
                {state?.server?.dbMode?.toUpperCase()} · {state?.server?.wsClients || 0} sockets · {state?.server?.uptimeSec || 0}s up
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {dirty && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3.5 py-2 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-xs sm:text-sm font-semibold text-[#F8FAFC] shadow-lg shadow-blue-600/25 transition"
              >
                {saving ? 'Pushing…' : 'Save & Push Live'}
              </button>
            )}
            <button
              onClick={() => fetchState(password)}
              className="px-3 py-2 rounded-xl bg-[#172033] border border-slate-400/15 text-xs font-medium text-[#CBD5E1] hover:border-blue-500/40"
            >
              Refresh
            </button>
            <button
              onClick={logout}
              className="hidden sm:inline-flex px-3 py-2 rounded-xl bg-[#172033] border border-slate-400/15 text-xs font-medium text-[#94A3B8] hover:text-red-300"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main Layout: Desktop Left Sidebar + Responsive Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-5 lg:grid lg:grid-cols-12 lg:gap-6">
        <aside className="hidden lg:block lg:col-span-3 space-y-2">
          <div className="glass-card rounded-2xl p-3 space-y-1.5 sticky top-20">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={`w-full text-left px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
                  tab === item.id
                    ? 'bg-[#2563EB]/20 border border-[#3B82F6]/40 text-[#60A5FA]'
                    : 'text-[#CBD5E1] hover:bg-[#172033]/70'
                }`}
              >
                {item.label}
              </button>
            ))}
            <div className="pt-3 mt-3 border-t border-slate-400/15 px-1 space-y-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="w-full py-2.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] text-xs font-semibold text-[#F8FAFC] transition disabled:opacity-50"
              >
                {saving ? 'Saving…' : dirty ? 'Save & Push Live' : 'All Changes Saved'}
              </button>
            </div>
          </div>
        </aside>

        <main className="lg:col-span-9 space-y-5">
          {statusMsg && (
            <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-300">
              {statusMsg}
            </div>
          )}
          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/40 text-xs text-red-300">
              {errorMsg}
            </div>
          )}

          {/* Top Telemetry Cards */}
          {(tab === 'overview' || tab === 'youtube') && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <div className="glass-card rounded-2xl p-4 space-y-2 sm:col-span-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#94A3B8]">YouTube Quota Used ({state?.quota?.day})</span>
                  <span className="font-mono font-semibold text-[#F8FAFC]">
                    {state?.quota?.used || 0} / {draft.youtubeChatQuotaBudget} units ({quotaPct}%)
                  </span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-[#0B1220] border border-slate-400/15 overflow-hidden">
                  <div
                    className={`h-full transition-all ${quotaPct > 85 ? 'bg-red-500' : 'bg-[#2563EB]'}`}
                    style={{ width: `${quotaPct}%` }}
                  />
                </div>
              </div>
              <div className="glass-card rounded-2xl p-4 flex flex-col justify-between">
                <span className="text-xs text-[#94A3B8]">Live Talk Rooms / Sockets</span>
                <div className="text-2xl font-bold text-[#F8FAFC] font-mono">
                  {state?.server?.activeRooms || 0} <span className="text-sm font-normal text-[#60A5FA]">/ {state?.server?.wsClients || 0} WS</span>
                </div>
              </div>
            </div>
          )}

          {/* YouTube Controls */}
          {(tab === 'overview' || tab === 'youtube') && (
            <section className="glass-card rounded-2xl p-4 sm:p-5 space-y-4">
              <div>
                <h2 className="text-base font-bold text-[#F8FAFC]">YouTube Live Polling &amp; Quota</h2>
                <p className="text-xs text-[#94A3B8]">Controls live chat polling, viewer/likes polling, and daily API quota units.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Toggle
                  label="YouTube Chat Polling"
                  subtitle="Enable or pause liveChatMessages.list on all active streams"
                  checked={draft.youtubeChatEnabled}
                  onChange={(v) => updateField('youtubeChatEnabled', v)}
                />
                <Toggle
                  label="Live Viewers & Likes Polling"
                  subtitle="Enable or pause videos.list live stats polling"
                  checked={draft.youtubeViewerStatsEnabled}
                  onChange={(v) => updateField('youtubeViewerStatsEnabled', v)}
                />
                <SliderField
                  label="Chat Poll Interval"
                  value={Math.round(draft.youtubeChatPollIntervalMs / 1000)}
                  min={5}
                  max={180}
                  step={5}
                  unit="s"
                  hint={`${Math.round(3600000 / draft.youtubeChatPollIntervalMs)} max polls/hr per stream`}
                  onChange={(sec) => updateField('youtubeChatPollIntervalMs', sec * 1000)}
                />
                <SliderField
                  label="Viewers & Likes Poll Interval"
                  value={Math.round(draft.youtubeViewerPollIntervalMs / 1000)}
                  min={10}
                  max={300}
                  step={5}
                  unit="s"
                  hint="Controls concurrent viewers & likes refresh rate"
                  onChange={(sec) => updateField('youtubeViewerPollIntervalMs', sec * 1000)}
                />
                <NumberField
                  label="Daily Quota Budget"
                  value={draft.youtubeChatQuotaBudget}
                  min={100}
                  max={100000}
                  hint="Project-wide Pacific-day ceiling"
                  onChange={(v) => updateField('youtubeChatQuotaBudget', v)}
                />
                <div className="grid grid-cols-3 gap-2">
                  <NumberField
                    label="Poll Units"
                    value={draft.youtubeChatPollUnits}
                    min={1}
                    max={100}
                    onChange={(v) => updateField('youtubeChatPollUnits', v)}
                  />
                  <NumberField
                    label="Send Units"
                    value={draft.youtubeChatSendUnits}
                    min={1}
                    max={200}
                    onChange={(v) => updateField('youtubeChatSendUnits', v)}
                  />
                  <NumberField
                    label="Stats Units"
                    value={draft.youtubeViewerPollUnits}
                    min={0}
                    max={50}
                    onChange={(v) => updateField('youtubeViewerPollUnits', v)}
                  />
                </div>
              </div>
            </section>
          )}

          {/* Talk Room Controls */}
          {(tab === 'overview' || tab === 'talk') && (
            <section className="glass-card rounded-2xl p-4 sm:p-5 space-y-4">
              <div>
                <h2 className="text-base font-bold text-[#F8FAFC]">Talk Rooms &amp; Realtime Controls</h2>
                <p className="text-xs text-[#94A3B8]">Adjust room capacity, chat flood limits, voice frame limits, and disconnect grace.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Toggle
                  label="Talk Rooms Enabled"
                  subtitle="Allow creating and joining Talk Rooms"
                  checked={draft.talkRoomsEnabled}
                  onChange={(v) => updateField('talkRoomsEnabled', v)}
                />
                <SliderField
                  label="Max Room Members"
                  value={draft.maxRoomMembers}
                  min={2}
                  max={50}
                  step={1}
                  unit=" users"
                  onChange={(v) => updateField('maxRoomMembers', v)}
                />
                <NumberField
                  label="Chat Rate Limit (Msgs)"
                  value={draft.chatRateLimitCount}
                  min={1}
                  max={60}
                  onChange={(v) => updateField('chatRateLimitCount', v)}
                />
                <SliderField
                  label="Chat Rate Window"
                  value={Math.round(draft.chatRateLimitWindowMs / 1000)}
                  min={1}
                  max={60}
                  step={1}
                  unit="s"
                  onChange={(sec) => updateField('chatRateLimitWindowMs', sec * 1000)}
                />
                <NumberField
                  label="Max Voice Frame (Bytes)"
                  value={draft.maxVoiceFrameBytes}
                  min={256}
                  max={8192}
                  onChange={(v) => updateField('maxVoiceFrameBytes', v)}
                />
                <SliderField
                  label="Disconnect Grace Window"
                  value={Math.round(draft.disconnectGraceMs / 1000)}
                  min={5}
                  max={300}
                  step={5}
                  unit="s"
                  onChange={(sec) => updateField('disconnectGraceMs', sec * 1000)}
                />
              </div>
            </section>
          )}

          {/* Active Live Talk Rooms Moderation */}
          {(tab === 'overview' || tab === 'rooms') && (
            <section className="glass-card rounded-2xl p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-[#F8FAFC]">Active Talk Rooms</h2>
                  <p className="text-xs text-[#94A3B8]">Monitor live rooms and force-close if needed.</p>
                </div>
              </div>
              {(!state?.rooms || state.rooms.length === 0) ? (
                <div className="p-4 rounded-xl bg-[#0B1220]/80 border border-slate-400/10 text-xs text-[#64748B]">
                  No active Talk Rooms right now.
                </div>
              ) : (
                <div className="space-y-2">
                  {state.rooms.map((r) => (
                    <div
                      key={r.code}
                      className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-[#172033]/70 border border-slate-400/15"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-[#F8FAFC] font-mono">
                          {r.code} <span className="text-xs font-normal text-[#60A5FA]">· {r.members} online</span>
                        </div>
                        <div className="text-xs text-[#94A3B8] truncate">
                          {r.names.join(', ')}
                        </div>
                      </div>
                      <button
                        onClick={() => closeRoom(r.code)}
                        className="shrink-0 px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/40 text-xs font-semibold text-red-300 hover:bg-red-500/25"
                      >
                        Close
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#0B1220]/95 backdrop-blur-xl border-t border-slate-400/15 px-2 py-1.5">
        <div className="grid grid-cols-4 gap-1">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`py-2 px-1 rounded-xl text-[11px] font-semibold transition ${
                tab === item.id
                  ? 'bg-[#2563EB]/20 text-[#60A5FA]'
                  : 'text-[#64748B]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<AdminApp />);
