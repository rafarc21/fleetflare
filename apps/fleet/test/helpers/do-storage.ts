// Shared Map-backed DurableObjectStorage fake — issue #371 (sweep-3 S3-F1).
// One builder for the narrow storage ports (StudioStorage, ObservedStorage,
// SweepStorage, TranscriptStorage) that used to be redefined per suite.
// `get` returns EXACTLY what was put: a stored null reads back null, not
// undefined — real DO storage never makes that conversion, and a fake that
// did hid the only lock shape a live studio holds between operations (#103).
// Per-file extras (multi-key put, write-failure injection, typed unions over
// several ports) stay local to each suite — this is the plain single-key core.

export function fakeStorage(seed?: Record<string, unknown>) {
  const map = new Map<string, unknown>();
  if (seed) for (const [key, value] of Object.entries(seed)) map.set(key, value);
  return {
    map,
    get: (async (key: string) => map.get(key)) as (key: string) => Promise<unknown>,
    put: (async (key: string, value: unknown) => {
      map.set(key, value);
    }) as (key: string, value: unknown) => Promise<void>,
  };
}
