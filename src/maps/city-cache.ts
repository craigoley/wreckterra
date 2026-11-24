/**
 * City cache: keeps built live cities on the device so a place plays offline after its first load.
 * A city is stored under `<rounded point>@<tile version>`, and a pointer record under the rounded
 * point alone names the newest version, so a later visit finds the city without asking the network
 * which tile version is current. The store is a two-method interface so tests (and browsers without
 * IndexedDB) can supply their own.
 */
import { CITY_VERSION, type CityData } from "./city-compiler";

export interface LatLon { lat: number; lon: number }

export type CacheRecord =
  | { kind: "city"; tileVersion: string; city: CityData }
  | { kind: "pointer"; key: string };

export interface CityStore {
  get(key: string): Promise<CacheRecord | undefined>;
  put(key: string, record: CacheRecord): Promise<void>;
}

/** Decimal places kept when rounding a picked point (about 110 m), so nearby picks share a city. */
export const POINT_DECIMALS = 3;

export function roundPoint(point: LatLon): LatLon {
  const scale = 10 ** POINT_DECIMALS;
  return { lat: Math.round(point.lat * scale) / scale + 0, lon: Math.round(point.lon * scale) / scale + 0 };
}

export function cityCacheKey(point: LatLon): string {
  const p = roundPoint(point);
  return `live-city:${p.lat.toFixed(POINT_DECIMALS)},${p.lon.toFixed(POINT_DECIMALS)}`;
}

export function versionedKey(pointKey: string, tileVersion: string): string {
  return `${pointKey}@${tileVersion}`;
}

/** True when a stored value still has the shape the game loads; stale or foreign records are ignored. */
export function looksLikeCity(value: unknown): value is CityData {
  if (typeof value !== "object" || value === null) return false;
  const city = value as Partial<CityData>;
  return city.version === CITY_VERSION
    && Array.isArray(city.buildings) && Array.isArray(city.roads) && Array.isArray(city.spawns)
    && typeof city.bounds === "object" && city.bounds !== null
    && typeof city.graph === "object" && city.graph !== null;
}

/** The newest cached city for a point, or null when none is stored. */
export async function readCachedCity(store: CityStore, pointKey: string): Promise<{ city: CityData; tileVersion: string } | null> {
  const pointer = await store.get(pointKey);
  if (!pointer || pointer.kind !== "pointer") return null;
  const record = await store.get(pointer.key);
  if (!record || record.kind !== "city" || !looksLikeCity(record.city)) return null;
  return { city: record.city, tileVersion: record.tileVersion };
}

export async function writeCachedCity(store: CityStore, pointKey: string, tileVersion: string, city: CityData): Promise<void> {
  const key = versionedKey(pointKey, tileVersion);
  await store.put(key, { kind: "city", tileVersion, city });
  await store.put(pointKey, { kind: "pointer", key });
}

/** A store that lives only as long as the page; used when IndexedDB is unavailable. */
export function createMemoryStore(): CityStore {
  const records = new Map<string, CacheRecord>();
  return {
    get: async (key) => records.get(key),
    put: async (key, record) => { records.set(key, record); },
  };
}

const DB_NAME = "wreckterra-cities";
const STORE_NAME = "cities";

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** An IndexedDB-backed store. It opens lazily, so building one never throws; using one without IndexedDB does. */
export function createIndexedDbStore(factory: IDBFactory | undefined = globalThis.indexedDB, name: string = DB_NAME): CityStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error("IndexedDB is not available in this browser"));
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened"));
    });
    return opened;
  };
  return {
    async get(key) {
      const db = await open();
      const value = await settle<unknown>(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key));
      return value === undefined ? undefined : (value as CacheRecord);
    },
    async put(key, record) {
      const db = await open();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
      });
      tx.objectStore(STORE_NAME).put(record, key);
      await done;
    },
  };
}
