export interface NavigationContext {
  isActive(): boolean;
  setPoll(poll: () => Promise<unknown>): void;
  setTitle(title: string): void;
  failed: boolean;
}
export interface NavigationEntry<View> {
  key: string;
  view: View | null;
  scroll: number;
  title: string;
  poll: (() => Promise<unknown>) | null;
}
export function createNavigation<View>(options: {
  load(key: string, context: NavigationContext): Promise<View>;
  show(view: View): void;
  loading(key: string): void;
  error(key: string, error: Error): View;
  changed(entry: NavigationEntry<View> | null): void;
  getScroll(): number;
  setScroll(value: number): void;
  cacheable(key: string): boolean;
  limit?: number;
}): {
  navigate(key: string, options?: { reload?: boolean }): Promise<unknown> | undefined;
  refresh(): Promise<unknown> | undefined;
  clear(): void;
};
