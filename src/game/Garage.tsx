/**
 * The progress panel on the start screen and the reward line on the results screen. Both say plainly
 * whether progress is on the device, and offer the way to recover it when it is not.
 */
import { useState, useSyncExternalStore, type ChangeEvent } from "react";
import type { ProblemKind, ProgressState, ProgressStore } from "../progress/profile";
import { garagePoints, garageView, passportBadges, type Award, type GarageRow } from "../progress/rewards";
import { VEHICLES } from "./VehicleScene";

function useProgress(store: ProgressStore): ProgressState {
  return useSyncExternalStore(store.subscribe, store.state, store.state);
}

const PROBLEMS: Record<ProblemKind, { message: string; action: string | null }> = {
  denied: { message: "this browser is blocking storage. Progress lasts only while this page is open, so keep a backup.", action: "Try saving again" },
  "write-failed": { message: "the browser refused the write. Progress is held on this page only until a save succeeds.", action: "Try saving again" },
  corrupt: { message: "the save on this device is damaged and has not been changed.", action: "Keep a copy and start a new save" },
  newer: { message: "the save on this device is from a newer version of the game and has not been changed. Reload to update.", action: null },
  evicted: { message: "your saved progress disappeared from this device. This page still has it.", action: "Save it again" },
};

function SaveStatus({ store }: { store: ProgressStore }) {
  const { profile, problem } = useProgress(store);
  if (problem) {
    const { message, action } = PROBLEMS[problem.kind];
    return <div className="save-problem">
      <p role="alert">Not saved: {message} <small>({problem.detail})</small></p>
      {action ? <button type="button" onClick={() => store.recover()}>{action}</button> : null}
    </div>;
  }
  return <p role="status" className="save-ok">{profile.matches.length === 0
    ? "No saved progress on this device yet. If you expected some, the browser may have cleared it: restore a backup below."
    : "Saved on this device only, with no sync to other devices. Results are unverified."}</p>;
}

/** What the match just played earned, and whether that is on the device. */
export function RewardSummary({ store, award }: { store: ProgressStore; award: Award }) {
  const { problem } = useProgress(store);
  return <div className="results-reward">
    <p>+{award.points} garage points{award.record.testDrive ? " (test drive: mastery starts once unlocked)" : " and mastery"}</p>
    <p role="status">{problem ? `Not saved: ${PROBLEMS[problem.kind].message}` : "Saved on this device (unverified result)."}</p>
  </div>;
}

function describeRow(row: GarageRow): string {
  if (row.access === "test-drive") return `Test drive: pick it and press Play. Unlocks in ${row.pointsToUnlock} more garage points.`;
  return [`Unlocked`, `mastery ${row.mastery}`, ...row.cosmetics].join(" · ");
}

function Backup({ store }: { store: ProgressStore }) {
  const [backup, setBackup] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const restore = () => {
    const result = store.importBackup(text);
    if (!result.ok) { setMessage(result.reason); return; }
    const count = `Restored ${result.added} ${result.added === 1 ? "result" : "results"}`;
    setMessage(result.state.saved ? `${count}.` : `${count}, not saved yet.`);
  };
  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    file.text().then(setText, (error: unknown) => setMessage(`That file could not be read (${error instanceof Error ? error.message : String(error)}).`));
  };
  return <details className="backup">
    <summary>Back up or restore progress</summary>
    <button type="button" onClick={() => setBackup(store.exportBackup())}>Show backup</button>
    {backup === null ? null : <>
      <label>Your backup<textarea readOnly rows={4} value={backup} onFocus={(event) => event.target.select()} /></label>
      <a download="wreckterra-progress.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(backup)}`}>Download backup file</a>
    </>}
    <label>Paste a backup<textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} /></label>
    <label>Or choose a backup file<input type="file" accept="application/json,.json" onChange={chooseFile} /></label>
    <button type="button" onClick={restore} disabled={text.trim() === ""}>Restore backup</button>
    {message ? <p role="status">{message}</p> : null}
  </details>;
}

export function Garage({ store }: { store: ProgressStore }) {
  const { profile } = useProgress(store);
  const badges = passportBadges(profile);
  return <section className="progress" aria-label="Progress">
    <h2>Progress</h2>
    <SaveStatus store={store} />
    <p>Garage points: {garagePoints(profile)} <small>(1 for finishing a match, 3 for winning)</small></p>
    <ul className="progress-vehicles" aria-label="Vehicle mastery">
      {garageView(profile).map((row) => <li key={row.id}><strong>{VEHICLES.find((v) => v.id === row.id)!.name}</strong><span>{describeRow(row)}</span></li>)}
    </ul>
    <h3>Passport</h3>
    {badges.length > 0
      ? <ul className="passport" aria-label="Passport badges">{badges.map((badge) => <li key={badge}>{badge}</li>)}</ul>
      : <p>No badges yet. Win at a suggested place, or last a whole match clock. Every place is open from the start.</p>}
    <Backup store={store} />
  </section>;
}
