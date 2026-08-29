import { useEffect, useState } from 'react';
import { getPreference, setPreference, resolveTheme, watchSystem } from '../theme.js';
import { Icon, usePopover } from './ui.jsx';

/**
 * Appearance control in the application header.
 *
 * The visible part is an indicator, not a switch: a sun, a track with the knob
 * on the side of the theme actually in effect, and a moon. Pressing it opens
 * the Appearance menu.
 *
 * The menu carries three choices rather than two, so "follow the operating
 * system" stays reachable after an explicit pick — a plain toggle would make
 * that choice unrecoverable.
 */
const OPTIONS = [
  { value: 'light', label: 'Light mode', icon: 'sun' },
  { value: 'dark', label: 'Dark mode', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'monitor' },
];

export default function ThemeToggle() {
  const [preference, setPref] = useState(getPreference);
  const [resolved, setResolved] = useState(() => resolveTheme());
  const { open, toggle, close, anchorProps } = usePopover();

  // Follow the OS while the preference is 'system'.
  useEffect(() => watchSystem((theme) => setResolved(theme)), []);

  function choose(value) {
    setPreference(value);
    setPref(value);
    setResolved(resolveTheme(value));
    close();
  }

  const current = OPTIONS.find((o) => o.value === preference);

  return (
    <div {...anchorProps}>
      <button
        type="button"
        className={`theme-control ${resolved === 'dark' ? 'is-dark' : 'is-light'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Appearance: ${current?.label || preference}`}
        title={
          preference === 'system'
            ? `Following the system (currently ${resolved})`
            : `${current?.label}`
        }
        onClick={toggle}
      >
        <Icon name="sun" size={15} className="theme-glyph" />
        <span className="theme-track" aria-hidden="true"><span className="theme-knob" /></span>
        <Icon name="moon" size={15} className="theme-glyph" />
      </button>

      {open && (
        <div className="menu menu-right" role="menu" aria-label="Appearance">
          <div className="menu-label">Appearance</div>
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={preference === o.value}
              className={`menu-item ${preference === o.value ? 'is-selected' : ''}`}
              onClick={() => choose(o.value)}
            >
              <Icon name={o.icon} size={15} className="menu-item-icon" />
              <span>{o.label}</span>
              {preference === o.value && <Icon name="check" size={14} className="menu-check" />}
            </button>
          ))}
          <div className="menu-foot">
            {preference === 'system'
              ? `Following your operating system — currently ${resolved}.`
              : 'Applies to every screen and is remembered on this device.'}
          </div>
        </div>
      )}
    </div>
  );
}
