export interface ActiveTabHostnameSnapshot {
  hostname: string;
}

export interface DebouncedActiveTabHandler<T extends ActiveTabHostnameSnapshot> {
  handle(snapshot: T): void;
  cancel(): void;
}

export function createDebouncedActiveTabHandler<T extends ActiveTabHostnameSnapshot>(
  onChange: (snapshot: T) => void,
  delayMs = 500,
): DebouncedActiveTabHandler<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: T | null = null;

  return {
    handle(snapshot: T): void {
      latest = snapshot;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (latest) onChange(latest);
      }, delayMs);
    },
    cancel(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      latest = null;
    },
  };
}
