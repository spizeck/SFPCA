"use client";

/**
 * Persistent control to reopen the Klaro consent settings. If Klaro hasn't
 * loaded yet (still initializing or blocked), the click is a harmless no-op.
 */
export function ConsentSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        window.klaro?.show(window.klaroConfig, true);
      }}
    >
      Cookie settings
    </button>
  );
}
