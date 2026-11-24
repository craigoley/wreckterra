import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Controls, TouchButton } from "../input/controls";
import { CONTROLS } from "../input/tuning";

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
function SteerPad({ controls }: { controls: Controls }) {
  const pad = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const active = useRef<{ id: number; x: number; y: number; rx: number; ry: number } | null>(null);
  const hide = () => { if (ring.current) ring.current.style.opacity = "0"; };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (active.current?.id !== event.pointerId) return;
    active.current = null;
    controls.touch.steerEnd(event.pointerId);
    hide();
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
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div ref={ring} className="steer-ring" aria-hidden="true"><div ref={knob} className="steer-knob" /></div>
      <span className="steer-hint" aria-hidden="true">Drag to steer</span>
    </div>
  );
}

function ActionButton({ controls, action, label }: { controls: Controls; action: TouchButton; label: string }) {
  const down = useRef<Set<number>>(new Set());
  const release = (id: number) => {
    if (down.current.delete(id)) controls.touch.release(action, id);
  };
  return (
    <button
      type="button"
      className={`action action-${action}`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        down.current.add(event.pointerId);
        controls.touch.press(action, event.pointerId);
      }}
      onPointerUp={(event) => release(event.pointerId)}
      onPointerCancel={(event) => release(event.pointerId)}
      onLostPointerCapture={(event) => release(event.pointerId)}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.repeat) { down.current.add(-1); controls.touch.press(action, -1); }
      }}
      onKeyUp={(event) => { if (event.key === "Enter") release(-1); }}
    >
      {label}
    </button>
  );
}

/**
 * On-screen controls laid over the view: a steering pad on the left half and big thumb weapons on
 * the right. Pointers are independent, so one thumb steers while the other fires.
 */
export function TouchControls({ controls }: { controls: Controls }) {
  return (
    <div className="touch-layer">
      <SteerPad controls={controls} />
      <div className="weapons" role="group" aria-label="Weapon controls">
        <ActionButton controls={controls} action="special" label="Special" />
        <ActionButton controls={controls} action="missile" label="Missile" />
        <ActionButton controls={controls} action="fire" label="Fire" />
      </div>
    </div>
  );
}
