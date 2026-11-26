/**
 * The box above the tree. Typing narrows the tree by name; Enter searches inside the requests.
 *
 * One box for both, the way Postman's sidebar has one: the name filter answers "which request is
 * called that" between two keystrokes, and when it is the wrong question the same text becomes a
 * content search without retyping it.
 */
import { useEffect, useRef } from "react";

import { runWorkspaceSearch } from "@preman/desktop/renderer/actions.js";
import { useSearchStore, type SearchState } from "@preman/desktop/renderer/stores/search.js";
import { Field } from "@preman/desktop/renderer/ui/Controls.js";

const selectFocusWanted = (state: SearchState): boolean => state.focusRequest === "filter";

export function TreeFilterBox(): React.JSX.Element {
  const box = useRef<HTMLInputElement>(null);
  const focusWanted = useSearchStore(selectFocusWanted);

  useEffect(() => {
    if (!focusWanted || box.current === null) return;
    const store = useSearchStore.getState();
    // Restore the filter's own text when its focus request is handled.
    box.current.value = store.filter;
    // Selected, so typing replaces the last filter rather than extending it.
    box.current.focus();
    box.current.select();
    store.focusHandled();
  }, [focusWanted]);

  return (
    <div className="shrink-0 border-b border-line p-2">
      <Field
        ref={box}
        // Read once: the store follows the input, never the other way round, and the box is
        // remounted by its parent when the workspace changes and the store is cleared.
        defaultValue={useSearchStore.getState().filter}
        placeholder="Filter by name, Enter to search"
        aria-label="Filter the tree by name"
        onChange={(event) => {
          useSearchStore.getState().setFilter(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            runWorkspaceSearch(event.currentTarget.value);
            return;
          }
          // Claimed only when there is something to clear, so an empty box leaves Escape to
          // whatever else is listening for it.
          if (event.key === "Escape" && event.currentTarget.value.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.value = "";
            useSearchStore.getState().setFilter("");
          }
        }}
      />
    </div>
  );
}
