import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBanner } from './ErrorBanner';
import { api, type Cadence } from '@d4/web-platform';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "a@x.com, b@y.org" → ["a@x.com", "b@y.org"] (blank entries dropped). */
const parseRecipients = (text: string) =>
  text
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** "06:00 UTC (08:00 here)" so people in any time zone pick the right hour. */
function hourLabel(h: number): string {
  const local = new Date(Date.UTC(2027, 0, 4, h)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${String(h).padStart(2, '0')}:00 UTC (${local} here)`;
}

export function CadenceFields({ value, onChange }: { value: Cadence; onChange(c: Cadence): void }) {
  const freqId = useId();
  const hourId = useId();
  const dayId = useId();
  const setFrequency = (f: Cadence['frequency']) =>
    onChange(f === 'daily' ? { frequency: f, hour: value.hour } : f === 'weekly' ? { frequency: f, hour: value.hour, weekday: 1 } : { frequency: f, hour: value.hour, day: 1 });
  return (
    <div className="cadence-fields">
      <div className="field">
        <label htmlFor={freqId}>Repeat</label>
        <select id={freqId} value={value.frequency} onChange={(e) => setFrequency(e.target.value as Cadence['frequency'])}>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </select>
      </div>
      {value.frequency === 'weekly' && (
        <div className="field">
          <label htmlFor={dayId}>On</label>
          <select id={dayId} value={value.weekday} onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}
      {value.frequency === 'monthly' && (
        <div className="field">
          <label htmlFor={dayId}>On day</label>
          <select id={dayId} value={value.day} onChange={(e) => onChange({ ...value, day: Number(e.target.value) })}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor={hourId}>At</label>
        <select id={hourId} value={value.hour} onChange={(e) => onChange({ ...value, hour: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => h).map((h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * Turns what is on screen into a scheduled report: the caller passes the job kind and
 * parameters; the user names it and picks a cadence.
 */
export function ScheduleForm({
  workspaceId,
  kind,
  params,
  defaultName,
  runDateHint,
  onClose,
}: {
  workspaceId: string;
  kind: 'export' | 'render';
  params: Record<string, unknown>;
  defaultName: string;
  runDateHint: string;
  onClose(): void;
}) {
  const nameId = useId();
  const mailId = useId();
  const [recipients, setRecipients] = useState('');
  const [name, setName] = useState(defaultName);
  const [cadence, setCadence] = useState<Cadence>({ frequency: 'weekly', hour: 6, weekday: 1 });
  const [useRunDate, setUseRunDate] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createSchedule(workspaceId, { name, kind, params, useRunDate, cadence, recipients: parseRecipients(recipients) });
      setSaved(true);
    } catch (err) {
      setError(err);
    }
  };

  if (saved) {
    return (
      <div className="schedule-form card" role="status">
        ✓ Scheduled. <Link to={`/w/${workspaceId}/reports`}>Manage in Reports</Link>{' '}
        <button type="button" className="button small ghost" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }
  return (
    <form className="schedule-form card" aria-label="Schedule report" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor={nameId}>Report name</label>
        <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </div>
      <CadenceFields value={cadence} onChange={setCadence} />
      <div className="field recipients">
        <label htmlFor={mailId}>Email to (optional)</label>
        <input id={mailId} type="text" inputMode="email" placeholder="name@example.com, …" value={recipients} onChange={(e) => setRecipients(e.target.value)} />
      </div>
      <label className="check-inline">
        <input type="checkbox" checked={useRunDate} onChange={(e) => setUseRunDate(e.target.checked)} /> {runDateHint}
      </label>
      {error != null && <ErrorBanner error={error} />}
      <div className="form-actions">
        <button className="button primary" type="submit">
          Schedule
        </button>
        <button className="button ghost" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
