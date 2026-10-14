import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { FiChevronDown } from 'react-icons/fi';

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`toggle ${checked ? 'is-on' : ''}`}
    >
      <span />
    </button>
  );
}

export function Section({
  number,
  title,
  action,
  children,
}: {
  number: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="control-section">
      <div className="section-heading">
        <h2>
          <span>{number}</span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Accordion({ title, className = '', children }: { title: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={`advanced-details ${className}`}>
      <button
        type="button"
        className="advanced-trigger"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {title}
        <FiChevronDown aria-hidden="true" />
      </button>
      <div id={id} className="accordion-panel" data-open={open} inert={!open} aria-hidden={!open}>
        <div className="accordion-content">{children}</div>
      </div>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const id = label.toLowerCase().replace(/ /g, '-');
  return (
    <div className="slider-control">
      <label htmlFor={id}>
        {label}
        <output htmlFor={id}>
          {value}
          {suffix}
        </output>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--range': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
