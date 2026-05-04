import { useState, useEffect } from 'react';
import type { RoutineSchedule } from '../../lib/rpc.js';

export type RoutineFormValues = {
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  timezone: string;
  deliverChat: boolean;
  deliverEmail: boolean;
  emailTo: string | null;
  enabled: boolean;
};

type Props = {
  initial?: Partial<RoutineFormValues>;
  defaultEmail: string;
  onCancel: () => void;
  onSubmit: (values: RoutineFormValues) => Promise<void>;
};

const WEEKDAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const FULL_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function RoutineForm({ initial, defaultEmail, onCancel, onSubmit }: Props) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [scheduleKind, setScheduleKind] = useState<RoutineSchedule['kind']>(initial?.schedule?.kind ?? 'daily');
  const [time, setTime] = useState((initial?.schedule && 'time' in initial.schedule ? initial.schedule.time : '09:00'));
  const [days, setDays] = useState<number[]>(
    initial?.schedule?.kind === 'weekly' ? initial.schedule.days : [1, 2, 3, 4, 5],
  );
  const [dayOfMonth, setDayOfMonth] = useState<number>(
    initial?.schedule?.kind === 'monthly' ? initial.schedule.dayOfMonth : 1,
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? browserTz);
  const [deliverEmail, setDeliverEmail] = useState(initial?.deliverEmail ?? false);
  const [emailTo, setEmailTo] = useState(initial?.emailTo ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // If editing, normalize time formatting (already 'HH:MM').
  }, [initial]);

  function buildSchedule(): RoutineSchedule | null {
    if (scheduleKind === 'daily') return { kind: 'daily', time };
    if (scheduleKind === 'weekly') {
      if (days.length === 0) return null;
      return { kind: 'weekly', days, time };
    }
    if (scheduleKind === 'monthly') {
      if (dayOfMonth < 1 || dayOfMonth > 28) return null;
      return { kind: 'monthly', dayOfMonth, time };
    }
    return null;
  }

  async function submit() {
    setErr(null);
    if (!name.trim()) { setErr('Name is required'); return; }
    if (!prompt.trim()) { setErr('Prompt is required'); return; }
    const schedule = buildSchedule();
    if (!schedule) { setErr('Pick at least one day for weekly schedules; monthly day-of-month must be 1–28'); return; }
    if (deliverEmail) {
      const target = (emailTo || defaultEmail).trim();
      if (!target || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
        setErr('Enter a valid email recipient or disable email delivery'); return;
      }
    }
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        prompt: prompt.trim(),
        schedule,
        timezone,
        deliverChat: true,
        deliverEmail,
        emailTo: emailTo.trim() ? emailTo.trim() : null,
        enabled,
      });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(i: number) {
    setDays((cur) => cur.includes(i) ? cur.filter((d) => d !== i) : [...cur, i].sort((a, b) => a - b));
  }

  return (
    <div className="bg-surface border border-border rounded-md p-5 space-y-4">
      <div>
        <label className="block text-xs text-text-muted mb-1.5 font-medium">Name</label>
        <input
          type="text"
          className="bg-bg border border-border rounded-md p-2 w-full text-sm text-text outline-none focus:border-accent transition-colors duration-150"
          placeholder="Weekly workload report"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </div>

      <div>
        <label className="block text-xs text-text-muted mb-1.5 font-medium">Prompt</label>
        <textarea
          className="bg-bg border border-border rounded-md p-2 w-full text-sm text-text resize-y outline-none focus:border-accent transition-colors duration-150"
          rows={3}
          placeholder="Show me a workload summary across the team and call out anyone overloaded."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2000}
        />
      </div>

      <div>
        <label className="block text-xs text-text-muted mb-1.5 font-medium">Schedule</label>
        <div className="flex gap-3 mb-3 text-sm">
          {(['daily', 'weekly', 'monthly'] as const).map((k) => (
            <label key={k} className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="kind"
                checked={scheduleKind === k}
                onChange={() => setScheduleKind(k)}
              />
              <span className="capitalize">{k}</span>
            </label>
          ))}
        </div>

        {scheduleKind === 'weekly' && (
          <div className="flex gap-1.5 mb-3">
            {WEEKDAY_NAMES.map((label, i) => (
              <button
                key={i}
                type="button"
                onClick={() => toggleDay(i)}
                className={`w-9 h-9 rounded-md text-xs font-medium transition-colors duration-150 ${
                  days.includes(i)
                    ? 'bg-accent text-white'
                    : 'bg-bg border border-border text-text-muted hover:text-text'
                }`}
                title={FULL_WEEKDAY_NAMES[i]}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {scheduleKind === 'monthly' && (
          <div className="mb-3">
            <label className="text-xs text-text-muted mr-2">Day of month (1–28)</label>
            <input
              type="number"
              min={1}
              max={28}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Math.max(1, Math.min(28, Number(e.target.value) || 1)))}
              className="bg-bg border border-border rounded-md px-2 py-1 w-16 text-sm text-text outline-none focus:border-accent"
            />
          </div>
        )}

        <div className="flex gap-2 items-center">
          <label className="text-xs text-text-muted">Time</label>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="bg-bg border border-border rounded-md px-2 py-1 text-sm text-text outline-none focus:border-accent"
          />
          <span className="text-xs text-text-subtle">{timezone}</span>
        </div>
      </div>

      <div>
        <label className="block text-xs text-text-muted mb-1.5 font-medium">Delivery</label>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-text-muted">In-app chat conversation</span>
          <span className="text-text-subtle">·</span>
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={deliverEmail}
              onChange={(e) => setDeliverEmail(e.target.checked)}
            />
            <span>Email</span>
          </label>
        </div>
        {deliverEmail && (
          <div className="mt-3">
            <label className="block text-xs text-text-muted mb-1.5">Email to</label>
            <input
              type="email"
              placeholder={defaultEmail}
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              className="bg-bg border border-border rounded-md p-2 w-full text-sm text-text outline-none focus:border-accent transition-colors duration-150"
            />
            <p className="text-xs text-text-subtle mt-1">Defaults to your account email if left blank.</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <label className="inline-flex items-center gap-1.5 cursor-pointer text-sm text-text-muted">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
        </label>
      </div>

      {err && <p className="text-sm text-error">{err}</p>}

      <div className="flex gap-2 pt-2 border-t border-border">
        <button
          onClick={submit}
          disabled={saving}
          className="bg-accent hover:bg-accent-hover text-white rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
        >
          {saving ? 'Saving…' : 'Save routine'}
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="text-text-muted hover:text-text hover:bg-surface-hover rounded-md px-4 py-2 text-sm font-medium transition-colors duration-150"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
