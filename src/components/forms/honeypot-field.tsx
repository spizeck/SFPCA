"use client";

// Honeypot field for unauthenticated public forms (#219).
//
// Rendered off-screen (not display:none — naive scrapers skip hidden
// inputs), removed from the tab order, and aria-hidden so sighted users
// and assistive technology never interact with it. Automated tooling
// that fills every input it finds gets a generic success-shaped
// response from the server action and nothing is written. Never put a
// real label or name here — "website" is deliberate bait.

interface HoneypotFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

export function HoneypotField({ id, value, onChange }: HoneypotFieldProps) {
  return (
    <div
      aria-hidden="true"
      className="absolute left-[-10000px] top-auto h-px w-px overflow-hidden"
    >
      <label htmlFor={id}>Website</label>
      <input
        id={id}
        name="website"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
      />
    </div>
  );
}
