export const VEHICLES = [
  { id: "switchback", name: "Switchback", role: "All-rounder", color: "#e88b43", speed: 3, armor: 3 },
  { id: "rivet", name: "Rivet", role: "Heavy bruiser", color: "#9dad88", speed: 2, armor: 5 },
  { id: "voltage", name: "Voltage", role: "Agile interceptor", color: "#b2cfde", speed: 5, armor: 2 },
] as const;
export type Vehicle = (typeof VEHICLES)[number];

export function VehicleScene({ vehicle }: { vehicle: Vehicle }) {
  return <div className="vehicle-scene">
    <svg viewBox="0 0 600 330" role="img" aria-label={`${vehicle.name} vehicle preview`}>
      <ellipse cx="300" cy="270" rx="210" ry="25" fill="#080d0a" />
      <path d="M55 265H545M85 285H515M130 305H470" stroke="#47604c" strokeWidth="1" />
      <g stroke="#111a16" strokeWidth="6" strokeLinejoin="round">
        <path d="M130 210L185 175L405 175L475 215L465 250L135 250Z" fill={vehicle.color} />
        <path d="M200 175L240 120L350 120L400 175Z" fill={vehicle.color} />
        <path d="M243 130L265 130L265 169L215 169Z M278 130L344 130L380 169L278 169Z" fill="#273f38" />
        <path d="M140 218H465M170 202H220M390 202H440" fill="none" />
        <circle cx="205" cy="248" r="35" fill="#18201a" /><circle cx="405" cy="248" r="35" fill="#18201a" />
        <circle cx="205" cy="248" r="16" fill="#9aa59b" /><circle cx="405" cy="248" r="16" fill="#9aa59b" />
        <path d="M305 119V93H330V119" fill="#89968b" />
      </g>
    </svg>
    <span className="scene-caption">Original machines. Real-world arenas.</span>
  </div>;
}
