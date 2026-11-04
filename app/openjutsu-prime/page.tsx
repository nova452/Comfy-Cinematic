import { Suspense } from "react";
import { OpenjutsuShortcut } from "../../components/openjutsu-shortcut";

/**
 * A reviewer's one-click entry: `/openjutsu-prime?key=…&deployment=…`, or a
 * friend's one-time gift, `/openjutsu-prime#gift=…&host=…`.
 *
 * Both are read in the browser (they hold a key or a gift token), so the page
 * is rendered per request and the client half sits behind Suspense. The
 * project's workspace renders right here once it is made.
 */
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <OpenjutsuShortcut />
    </Suspense>
  );
}
