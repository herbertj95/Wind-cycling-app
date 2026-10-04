/**
 * North-up dial. The arrow enters from where the wind comes from and points the way it blows.
 * With a `bearing`, a small triangle in the middle shows which way the rider is heading,
 * so head, tail and crosswind can be read off at a glance.
 * Leave `from` out when the air is still: a calm has no direction to draw.
 */
export default function WindDial({ from, bearing }) {
  const hasWind = Number.isFinite(from);
  return (
    <svg className="wind-dial" viewBox="0 0 76 76" aria-hidden="true">
      <circle cx="38" cy="38" r="30" fill="none" stroke="var(--hair)" strokeWidth="1.5" />
      <path d="M71 38h-6M38 71v-6M5 38h6" stroke="var(--ink-3)" strokeWidth="1.5" strokeLinecap="round" />
      {/* north is a heavier tick with its letter, so the dial reads at any size */}
      <path d="M38 4v8" stroke="var(--ink-2)" strokeWidth="2.5" strokeLinecap="round" />
      <text x="38" y="25" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--ink-2)">N</text>
      {Number.isFinite(bearing) && (
        <path d="M38 27l7 17-7-4-7 4z" fill="var(--ink-3)" transform={`rotate(${Math.round(bearing)} 38 38)`} />
      )}
      {hasWind && (
        <path
          d="M38 9v50M38 62l-8-12M38 62l8-12"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          transform={`rotate(${Math.round(from)} 38 38)`}
        />
      )}
    </svg>
  );
}
