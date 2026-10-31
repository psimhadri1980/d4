import type { AttributeDef } from '@d4/metamodel';

interface Props {
  def: AttributeDef;
  value: string | boolean;
  onChange(v: string | boolean): void;
  /** Enum values; for `lifecycle` this is narrowed to allowed transitions. */
  options?: readonly string[];
}

const label = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/** One metamodel attribute rendered as the matching input. */
export function AttributeField({ def, value, onChange, options }: Props) {
  const id = `attr-${def.name}`;
  const common = { id, name: def.name, required: def.required };
  const text = typeof value === 'string' ? value : '';

  let input;
  switch (def.type) {
    case 'boolean':
      input = <input {...common} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case 'text':
      input = <textarea {...common} rows={3} value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'enum':
      input = (
        <select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(options ?? []).map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
      break;
    case 'number':
    case 'integer':
      input = (
        <input {...common} type="number" step={def.type === 'integer' ? 1 : 'any'} value={text} onChange={(e) => onChange(e.target.value)} />
      );
      break;
    case 'date':
      input = <input {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'datetime':
      input = <input {...common} type="datetime-local" value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'url':
      input = <input {...common} type="url" value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'string[]':
      input = <input {...common} placeholder="comma, separated" value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    default:
      input = <input {...common} value={text} onChange={(e) => onChange(e.target.value)} />;
  }

  return (
    <div className={`field ${def.type === 'boolean' ? 'checkbox' : ''}`}>
      <label htmlFor={id}>
        {label(def.name)}
        {def.required && <span className="req"> *</span>}
      </label>
      {input}
      {def.description && <small className="muted">{def.description}</small>}
    </div>
  );
}
