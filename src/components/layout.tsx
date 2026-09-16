import { Link } from "@tanstack/react-router";

/**
 * Shared chrome for every page: one header, one nav, one honest storage
 * banner. The header stays on a single line at desktop; the wordmark tagline
 * hides before the nav ever wraps.
 */

const NAV = [
  { to: "/", label: "Command" },
  { to: "/tasks", label: "Tasks" },
  { to: "/saved", label: "Saved" },
  { to: "/agents", label: "Agents" },
  { to: "/settings", label: "Settings" },
] as const;

export function AppHeader() {
  return (
    <header className="sticky top-0 z-40 border-b hairline bg-ink/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-3 px-3 md:px-6">
        <Link to="/" className="flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-sm font-semibold tracking-tight text-heading">
            DealFinder Command Center
          </span>
          <span className="mono hidden text-[10px] uppercase tracking-widest text-muted lg:inline">
            personal agent ops
          </span>
        </Link>
        <nav aria-label="Primary" className="flex items-center gap-0.5 sm:gap-1">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-full px-2 py-1.5 text-[13px] text-body hover:bg-panel hover:text-heading sm:px-3 sm:text-sm"
              activeProps={{ className: "bg-panel text-heading font-medium" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

export interface StorageState {
  mode: string;
  ok: boolean;
  error: string | null;
}

/** Real storage state, labeled honestly on every page that shows data. */
export function StorageBanner({ storage }: { storage: StorageState | undefined }) {
  if (!storage) return null;
  if (!storage.ok) {
    return (
      <div
        role="alert"
        className="mb-4 rounded-[10px] border border-err/40 bg-err/5 px-4 py-3 text-sm text-err"
      >
        Storage error: {storage.error} Tasks and results cannot be saved until this is resolved.
      </div>
    );
  }
  if (storage.mode === "ephemeral") {
    return (
      <p className="mb-4 rounded-[10px] border border-accent/40 bg-accent/5 px-4 py-3 text-sm text-body">
        <span className="font-medium text-accent">Ephemeral mode:</span> data is not persisted and
        resets on restart. Set DATABASE_URL to switch this page to Postgres. Everything else works
        the same.
      </p>
    );
  }
  return null;
}
