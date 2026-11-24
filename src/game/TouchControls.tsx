import type { PointerEvent as ReactPointerEvent } from "react";

export type Held = {
  left: boolean;
  right: boolean;
  gas: boolean;
  reverse: boolean;
  brake: boolean;
  fire: boolean;
  missile: boolean;
  special: boolean;
};

export const IDLE: Held = { left: false, right: false, gas: false, reverse: false, brake: false, fire: false, missile: false, special: false };

/** Keyboard bindings: arrows or WASD drive, Space or J fires, K launches a missile, L or E uses the special. */
export const KEYS: Record<string, keyof Held> = {
  ArrowLeft: "left", a: "left", A: "left",
  ArrowRight: "right", d: "right", D: "right",
  ArrowUp: "gas", w: "gas", W: "gas",
  ArrowDown: "reverse", s: "reverse", S: "reverse",
  b: "brake", B: "brake", Shift: "brake",
  " ": "fire", j: "fire", J: "fire",
  k: "missile", K: "missile",
  l: "special", L: "special", e: "special", E: "special",
};

function HoldButton({ label, control, held }: { label: string; control: keyof Held; held: { current: Held } }) {
  const press = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    held.current[control] = true;
  };
  const release = () => {
    held.current[control] = false;
  };
  return (
    <button
      type="button"
      className={`hold hold-${control}`}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Enter") held.current[control] = true;
      }}
      onKeyUp={() => release()}
    >
      {label}
    </button>
  );
}

/** On-screen controls: every button works while another is held, so a thumb can steer and fire together. */
export function TouchControls({ held }: { held: { current: Held } }) {
  return (
    <div className="controls">
      <div className="pad" role="group" aria-label="Driving controls">
        <HoldButton label="◀ Left" control="left" held={held} />
        <HoldButton label="Right ▶" control="right" held={held} />
        <HoldButton label="Gas" control="gas" held={held} />
        <HoldButton label="Reverse" control="reverse" held={held} />
        <HoldButton label="Brake" control="brake" held={held} />
      </div>
      <div className="pad pad-weapons" role="group" aria-label="Weapon controls">
        <HoldButton label="Fire gun" control="fire" held={held} />
        <HoldButton label="Missile" control="missile" held={held} />
        <HoldButton label="Special" control="special" held={held} />
      </div>
    </div>
  );
}
