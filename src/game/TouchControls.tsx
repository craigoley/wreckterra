import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TouchButton } from "../input/controls";
import { CONTROLS } from "../input/tuning";
import type { DrivingControls } from "./input";

/**
 * The held-button shape the older `readControls` helper in CityScene still reads. The game itself
 * no longer uses it: every device goes through `createControls` and its one `InputIntent`.
 */
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

/** Where the drag ring and knob sit, relative to the pad. Pure drawing: the steering itself is measured by the controls. */
function placeKnob(ring: HTMLElement | null, knob: HTMLElement | null, originX: number, originY: number, dx: number, dy: number): void {
  if (!ring || !knob) return;
  const reach = Math.hypot(dx, dy);
  const scale = reach > CONTROLS.maxDragPx ? CONTROLS.maxDragPx / reach : 1;
  ring.style.transform = `translate(${originX}px, ${originY}px)`;
  knob.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
}

/** The left half of the view: put a thumb down anywhere and drag; the touch point is the centre. */
function SteerPad({ controls }: { controls: DrivingControls }) {
  const pad = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const active = useRef<{ id: number; x: number; y: number; rx: number; ry: number } | null>(null);
  const hide = () => { if (ring.current) ring.current.style.opacity = "0"; };
  // After any release the pad must take the next finger, whether or not the old one ever reports lifting.
  useEffect(() => controls.onRelease(() => { active.current = null; hide(); }), [controls]);
  const lift = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (active.current?.id !== event.pointerId) return;
    active.current = null;
    controls.touch.steerEnd(event.pointerId);
    hide();
  };
  // A contact taken away rather than lifted releases everything. After a normal lift it is no longer tracked.
  const lose = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (active.current?.id === event.pointerId) controls.clear();
  };
  return (
    <div
      ref={pad}
      className="steer-pad"
      role="group"
      aria-label="Steering pad: drag left or right to steer, drag down to reverse"
      onPointerDown={(event) => {
        if (active.current) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const rect = pad.current?.getBoundingClientRect();
        const rx = event.clientX - (rect?.left ?? 0);
        const ry = event.clientY - (rect?.top ?? 0);
        active.current = { id: event.pointerId, x: event.clientX, y: event.clientY, rx, ry };
        controls.touch.steerStart(event.pointerId, event.clientX, event.clientY);
        placeKnob(ring.current, knob.current, rx, ry, 0, 0);
        if (ring.current) ring.current.style.opacity = "1";
      }}
      onPointerMove={(event) => {
        const start = active.current;
        if (!start || start.id !== event.pointerId) return;
        controls.touch.steerMove(event.pointerId, event.clientX, event.clientY);
        placeKnob(ring.current, knob.current, start.rx, start.ry, event.clientX - start.x, event.clientY - start.y);
      }}
      onPointerUp={lift}
      onPointerCancel={lose}
      onLostPointerCapture={lose}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div ref={ring} className="steer-ring" aria-hidden="true"><div ref={knob} className="steer-knob" /></div>
      <span className="steer-hint" aria-hidden="true">Drag to steer</span>
    </div>
  );
}

/** A button held down by one or more pointers, each tracked on its own. */
function HoldButton({ controls, name, label, press, lift }: { controls: DrivingControls; name: string; label: string; press: (id: number) => void; lift: (id: number) => void }) {
  const down = useRef<Set<number>>(new Set());
  useEffect(() => controls.onRelease(() => down.current.clear()), [controls]);
  const hold = (id: number) => { down.current.add(id); press(id); };
  const release = (id: number) => { if (down.current.delete(id)) lift(id); };
  const lose = (id: number) => { if (down.current.has(id)) controls.clear(); };
  return (
    <button
      type="button"
      className={`action action-${name}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        hold(event.pointerId);
      }}
      onPointerUp={(event) => release(event.pointerId)}
      onPointerCancel={(event) => lose(event.pointerId)}
      onLostPointerCapture={(event) => lose(event.pointerId)}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => { if (event.key === "Enter" && !event.repeat) hold(-1); }}
      onKeyUp={(event) => { if (event.key === "Enter") release(-1); }}
    >
      {label}
    </button>
  );
}

/** Switches the assisted accelerator; the choice is remembered on the device. */
function AssistToggle({ controls }: { controls: DrivingControls }) {
  const [on, setOn] = useState(() => controls.assist);
  return (
    <button type="button" className="assist" aria-pressed={on} onClick={() => { controls.setAssist(!on); setOn(!on); }}>
      Auto gas: {on ? "on" : "off"}
    </button>
  );
}

/**
 * On-screen controls laid over the view: a steering pad on the left and big thumb buttons for the brake
 * and the weapons on the right. Pointers are independent, so one thumb steers while the other fires.
 */
export function TouchControls({ controls }: { controls: DrivingControls }) {
  const weapon = (button: TouchButton, label: string) => (
    <HoldButton controls={controls} name={button} label={label} press={(id) => controls.touch.press(button, id)} lift={(id) => controls.touch.release(button, id)} />
  );
  return (
    <div className="touch-layer">
      <SteerPad controls={controls} />
      <div className="weapons" role="group" aria-label="Weapon controls">
        <HoldButton controls={controls} name="brake" label="Brake" press={(id) => controls.brake(true, id)} lift={(id) => controls.brake(false, id)} />
        {weapon("special", "Special")}
        {weapon("missile", "Missile")}
        {weapon("fire", "Fire")}
      </div>
      <AssistToggle controls={controls} />
    </div>
  );
}
