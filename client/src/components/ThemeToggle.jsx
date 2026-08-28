import { useEffect, useState } from 'react';
import { getPreference, setPreference, resolveTheme, watchSystem } from '../theme.js';

/**
 * Light / System / Dark segmented control.
 *
 * Three options rather than a two-state switch, so "follow the operating
 * system" stays reachable after the user has picked something — a plain toggle
 * makes that choice unrecoverable.
 *
 * Exposed as a radiogroup: arrow keys move between options, and each option
 * reports its own pressed state to assistive technology.
 */
const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
];

function Glyph({ name }) {
  const p = {
    width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  };
  if (name === 'light') {
    return (
      <svg {...p}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.2M8 13.3v1.2M14.5 8h-1.2M2.7 8H1.5M12.6 3.4l-.85.85M4.25 11.75l-.85.85M12.6 12.6l-.85-.85M4.25 4.25l-.85-.85" />
      </svg>
    );
  }
  if (name === 'dark') {
    return (
      <svg {...p}>
        <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <rect x="1.75" y="3" width="12.5" height="8.5" rx="1.2" />
      <path d="M6 14h4" />
    </svg>
  );
}

export default function ThemeToggle() {
  const [preference, setPref] = useState(getPreference);
  const [resolved, setResolved] = useState(() => resolveTheme());

  // Follow the OS while the preference is 'system'.
  useEffect(() => watchSystem((theme) => setResolved(theme)), []);

  function choose(value) {
    setPreference(value);
    setPref(value);
    setResolved(resolveTheme(value));
  }

  function onKeyDown(e) {
    const i = OPTIONS.findIndex((o) => o.value === preference);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      choose(OPTIONS[(i + 1) % OPTIONS.length].value);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      choose(OPTIONS[(i - 1 + OPTIONS.length) % OPTIONS.length].value);
    }
  }

  return (
    <div
      className="theme-toggle"
      role="radiogroup"
      aria-label="Colour theme"
      onKeyDown={onKeyDown}
    >
      {OPTIONS.map((o) => {
        const selected = preference === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`theme-option ${selected ? 'is-selected' : ''}`}
            onClick={() => choose(o.value)}
            title={
              o.value === 'system'
                ? `Follow the system (currently ${resolved})`
                : `${o.label} theme`
            }
          >
            <Glyph name={o.value} />
            <span className="sr-only">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
