declare class Terminal {
  constructor(opts?: Record<string, unknown>);
  cols: number;
  rows: number;
  element: HTMLElement | undefined;
  options: Record<string, unknown>;
  buffer: { active: { viewportY: number; baseY: number } };
  open(container: HTMLElement): void;
  write(data: string): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  onScroll(cb: (newPosition: number) => void): void;
  scrollToBottom(): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  focus(): void;
  loadAddon(addon: unknown): void;
}

declare namespace FitAddon {
  class FitAddon {
    fit(): void;
  }
}

declare namespace SearchAddon {
  class SearchAddon {
    findNext(term: string): void;
    findPrevious(term: string): void;
    clearDecorations(): void;
  }
}
