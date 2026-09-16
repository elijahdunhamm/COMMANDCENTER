import { HeadContent, Outlet, Scripts, createRootRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "DealFinder Command Center" },
      {
        name: "description",
        content:
          "Personal dashboard for managing AI agents that run real tasks: commands in, structured results out.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: () => (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-xl font-semibold text-heading">Page not found</h1>
      <p className="mt-2 text-sm">
        That address does not match any page. <Link to="/" className="text-accent underline underline-offset-4">Back to the command center</Link>.
      </p>
    </main>
  ),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[10px] focus:bg-panel focus:px-3 focus:py-2 focus:text-sm focus:text-heading"
        >
          Skip to content
        </a>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
