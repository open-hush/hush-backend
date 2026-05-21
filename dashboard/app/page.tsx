export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <header className="space-y-2">
        <p className="text-sm uppercase tracking-widest text-neutral-500">Hush</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Dashboard</h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Work in progress. The dashboard will let you manage your devices,
          upload audio and bind RFID cards.
        </p>
      </header>

      <section className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <h2 className="mb-2 text-lg font-medium">Roadmap</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          <li>Phase 1 — auth + device registration</li>
          <li>Phase 2 — audio upload + transcoding</li>
          <li>Phase 3 — device sync + events feed</li>
          <li>Phase 4 — full dashboard UI</li>
        </ul>
      </section>

      <footer className="text-xs text-neutral-500">
        <a className="underline" href="https://open-hush.com">
          open-hush.com
        </a>
        {" · "}
        <a className="underline" href="https://docs.open-hush.com">
          docs
        </a>
      </footer>
    </main>
  );
}
