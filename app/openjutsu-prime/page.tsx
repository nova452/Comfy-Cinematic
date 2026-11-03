import { Suspense } from "react";
import { OpenjutsuShortcut } from "../../components/openjutsu-shortcut";

/**
 * A reviewer's one-click entry: `/openjutsu-prime?key=…&deployment=…`.
 *
 * The query string is read in the browser (it holds a key), so the page is
 * rendered per request and the client half sits behind Suspense.
 */
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense
      fallback={
        <main className="shortcut">
          <p>Opening Openjutsu Prime…</p>
        </main>
      }
    >
      <OpenjutsuShortcut />
    </Suspense>
  );
}
