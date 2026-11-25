/**
 * Difficulty: how hard the bots fight. All the tuning lives here. A level changes how bots hit,
 * aim and press (damage, spread, opening grace, aim cone, missile rate), never how they drive or
 * route, and never the player's car, the weapons, pickups, the time limit or the four-bot count.
 *
 * Normal is the bot rules as they were before levels existed, value for value, so a match that
 * names no difficulty replays exactly as it always did. Only the start screen defaults to Easy.
 */
export type Difficulty = "easy" | "normal" | "hard";

export interface BotRules {
  /** Bot gun and missile damage, as a fraction of the player's. */
  botDamageScale: number;
  /** Half-width of a bot gun's random aim error, radians. */
  botSpread: number;
  /** Ticks a match is old before bots open fire. */
  botGraceTicks: number;
  /** How far off straight ahead (radians) a bot may be and still fire its gun. */
  botGunAlignment: number;
  /** Chance per think that a bot with a lock fires a missile. */
  botMissileChance: number;
}

export interface DifficultyInfo {
  id: Difficulty;
  label: string;
  description: string;
}

export const DIFFICULTIES: readonly DifficultyInfo[] = [
  { id: "easy", label: "Easy", description: "Bots hit softer, aim worse and wait longer before they fire." },
  { id: "normal", label: "Normal", description: "The standard fight." },
  { id: "hard", label: "Hard", description: "Bots hit harder, aim truer and open fire sooner." },
];

/** What the start screen offers first. A match that names no level is Normal, not this. */
export const DEFAULT_MENU_DIFFICULTY: Difficulty = "easy";
/** What a match runs on when it is given no level: today's rules. */
export const DEFAULT_MATCH_DIFFICULTY: Difficulty = "normal";

const RULES: Record<Difficulty, BotRules> = {
  normal: { botDamageScale: 0.45, botSpread: 0.045, botGraceTicks: 240, botGunAlignment: 0.14, botMissileChance: 0.05 },
  easy: { botDamageScale: 0.28, botSpread: 0.075, botGraceTicks: 420, botGunAlignment: 0.09, botMissileChance: 0.02 },
  hard: { botDamageScale: 0.62, botSpread: 0.032, botGraceTicks: 150, botGunAlignment: 0.18, botMissileChance: 0.08 },
};

export function isDifficulty(value: unknown): value is Difficulty {
  return value === "easy" || value === "normal" || value === "hard";
}

export function difficultyRules(level: Difficulty = DEFAULT_MATCH_DIFFICULTY): BotRules {
  return RULES[level];
}
