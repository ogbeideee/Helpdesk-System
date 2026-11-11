import { useEffect, useState } from 'react';
import { getPreference, setPreference, resolveTheme, watchSystem } from '../theme.js';
import { Icon, usePopover } from './ui.jsx';

/**
 * Appearance control in the application header.
 *
 * One control, and it names the choice in force: the icon is the mode you are
 * actually in, and the label says the same thing in words. It replaced a sun, a
 * switch and a moon sitting side by side — three glyphs that between them
 * communicated none of the three choices, and took a third of the header's
 * width to do it.
 *
 * The menu still carries three options rather than two, so "follow the operating
 * system" stays reachable after an explicit pick — a plain toggle would make
 * that choice unrecoverable.
 */
const OPTIONS = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
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

  const current = OPTIONS.find((o) => o.value === preference) || OPTIONS[2];

  return (
    <div {...anchorProps}>
      <button
        type="button"
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Appearance: ${current.label}`}
        title={
          preference === 'system'
            ? `Appearance: following the system (currently ${resolved})`
            : `Appearance: ${current.label}`
        }
        onClick={toggle}
      >
        <Icon name={current.icon} size={17} />
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
