export class ToolSelectionStore {
  private readonly selections = new Map<string, Set<string>>();

  select(scope: { sessionId: string; taskId?: string }, names: readonly string[]): string[] {
    const key = this.keyFor(scope);
    const set = this.selections.get(key) ?? new Set<string>();
    for (const name of names) {
      if (name) set.add(name);
    }
    this.selections.set(key, set);
    return [...set];
  }

  getSelected(scope: { sessionId: string; taskId?: string }): string[] {
    return [...(this.selections.get(this.keyFor(scope)) ?? [])];
  }

  clear(scope: { sessionId: string; taskId?: string }): void {
    this.selections.delete(this.keyFor(scope));
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.selections.keys()) {
      if (key.startsWith(prefix)) {
        this.selections.delete(key);
      }
    }
  }

  private keyFor(scope: { sessionId: string; taskId?: string }): string {
    return `${scope.sessionId}:${scope.taskId ?? 'session'}`;
  }
}

let defaultStore: ToolSelectionStore | undefined;

export function getDefaultToolSelectionStore(): ToolSelectionStore {
  defaultStore ??= new ToolSelectionStore();
  return defaultStore;
}
